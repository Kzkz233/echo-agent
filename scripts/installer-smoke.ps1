param(
  [Parameter(Mandatory=$true)][string]$Installer,
  [string]$PreviousInstaller,
  [string]$Report = 'test-results\installer-smoke.json',
  [switch]$RequireCli
)
$ErrorActionPreference = 'Stop'
$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$previousPath = if ($PreviousInstaller) { (Resolve-Path -LiteralPath $PreviousInstaller).Path } else { $installerPath }
$registryRelative = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\Echo Agent'
foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryHive]::LocalMachine)) {
  foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32)) {
    $baseKey = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view)
    try { $existing = $baseKey.OpenSubKey($registryRelative); if ($existing) { $existing.Dispose(); throw 'An Echo installer registration already exists; use a clean Windows test environment.' } }
    finally { $baseKey.Dispose() }
  }
}
$manufacturerKey = 'HKCU:\Software\echo\Echo Agent'
if (Test-Path -LiteralPath $manufacturerKey) { throw 'An existing Echo installer preference must not be overwritten.' }
$runKey = Get-Item 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
if ($runKey.GetValueNames() -contains 'Echo Agent') { throw 'An existing Echo autostart entry must not be changed.' }
$testBase = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) 'EchoInstallerTests'))
$sandbox = [IO.Path]::GetFullPath((Join-Path $testBase ([guid]::NewGuid().ToString())))
if (-not $sandbox.StartsWith($testBase + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe test location' }
$installation = Join-Path $sandbox 'App'
$dataDirectory = Join-Path $sandbox 'Data'
New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $dataDirectory 'retention-marker.txt'),'SYNTHETIC_INSTALLER_DATA')
$core = $null
$connection = $null
$success = $false
function Install-EchoFixture([string]$File,[bool]$Upgrade) {
  $arguments = @('/S','/NS')
  if ($Upgrade) { $arguments += '/UPDATE' }
  else { $arguments += '/D=' + $installation }
  $process = Start-Process -FilePath $File -ArgumentList $arguments -WindowStyle Hidden -PassThru
  if (-not $process.WaitForExit(300000)) { throw 'Installer did not finish within five minutes.' }
  $process.Refresh()
  if ($process.ExitCode -ne 0) { throw ('Installer exit code: ' + $process.ExitCode) }
  if (-not (Test-Path -LiteralPath (Join-Path $installation 'echo-desktop.exe'))) { throw 'Installed desktop executable missing' }
}
function Invoke-EchoFixture([string]$Method,$Params = @{}) {
  $body = @{jsonrpc='2.0';id=1;method=$Method;params=$Params} | ConvertTo-Json -Depth 60 -Compress
  $value = Invoke-RestMethod -Uri ($script:connection.url + '/rpc') -Method Post -ContentType 'application/json' -Headers @{Authorization='Bearer '+$script:connection.token} -Body $body -TimeoutSec 30
  if ($value.error) { throw ($Method + ': ' + $value.error.message) }
  return $value.result
}
function Start-EchoFixture([string]$Label) {
  $runtime = Join-Path $installation 'runtime'
  $env:ECHO_DATA_DIR = $dataDirectory
  $env:ECHO_PROJECT_ROOT = $runtime
  $env:ECHO_NATIVE_PATH = Join-Path $runtime 'echo-native.exe'
  $env:ECHO_PORT = '0'
  Remove-Item Env:ECHO_PLUGINS -ErrorAction SilentlyContinue
  $serverFile = Join-Path $runtime 'dist\server.mjs'
  $script:core = Start-Process -FilePath (Join-Path $runtime 'node.exe') -ArgumentList ('"'+$serverFile+'"') -WorkingDirectory $runtime -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $sandbox ($Label+'.stdout.log')) -RedirectStandardError (Join-Path $sandbox ($Label+'.stderr.log'))
  $deadline = (Get-Date).AddSeconds(30)
  while (-not (Test-Path -LiteralPath (Join-Path $dataDirectory 'connection.json'))) {
    if ($script:core.HasExited -or (Get-Date) -gt $deadline) { throw 'Installed runtime did not start.' }
    Start-Sleep -Milliseconds 200
  }
  $script:connection = Get-Content -LiteralPath (Join-Path $dataDirectory 'connection.json') -Raw | ConvertFrom-Json
  if (([uri]$script:connection.url).Host -ne '127.0.0.1') { throw 'Unexpected fixture endpoint' }
  return (Invoke-EchoFixture 'system.status').version
}
function Stop-EchoFixture {
  if ($script:core -and -not $script:core.HasExited) {
    Invoke-EchoFixture 'system.shutdown' | Out-Null
    if (-not $script:core.WaitForExit(30000)) { throw 'Fixture runtime did not stop cleanly.' }
  }
  $script:core = $null
}
try {
  Install-EchoFixture $previousPath $false
  $beforeVersion = Start-EchoFixture 'before'
  $role = Invoke-EchoFixture 'persona.character.commit' @{requestId='installer-create';draft=@{
    persona=@{id='installer-fixture';name='Installer fixture';prompt='SYNTHETIC_INSTALLER_SENTINEL'}
    features=@('memory','review')
    tasks=@(@{id='installer-review';type='review.policies';settings=@{enabled=$false;name='Synthetic review';mode='turns';rounds=99;contextMode='fresh';memoryOperations=@('add','update');autoApply=$false}})
  }}
  Invoke-EchoFixture 'notifications.publish' @{id='installer-note';title='Fixture';text='SYNTHETIC_HISTORY_SENTINEL';conversationId=$role.mainConversationId; bubble=$false} | Out-Null
  Invoke-EchoFixture 'characters.setActive' @{personaId='installer-fixture';enabled=$false;revision=0} | Out-Null
  Invoke-EchoFixture 'plugins.enable' @{id='care';enabled=$true} | Out-Null
  Invoke-EchoFixture 'automation.save' @{type='care.rules';id='installer-care';settings=@{name='Synthetic legacy care';enabled=$false;conversationId=$role.mainConversationId;mode='probability';probability=17}} | Out-Null
  # User-installed code and encrypted MCP credentials are data, never installer resources.
  $extensionRoot = Join-Path $dataDirectory 'extensions-manual\fixture'
  New-Item -ItemType Directory -Path $extensionRoot -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $extensionRoot 'echo-plugin.json'),(@{apiVersion=1;id='installer-extension';name='Installer extension fixture';description='Synthetic independent extension';version='1.0.0';permissions=@('installer-extension.read');command='node';args=@('entry.mjs')} | ConvertTo-Json -Depth 10))
  $extensionCode = @'
import readline from 'node:readline';
for await (const line of readline.createInterface({input:process.stdin})) {
 const m=JSON.parse(line);let result;
 if(m.method==='echo/initialize')result={operations:[{name:'installer-extension.read',description:'Fixture',inputSchema:{type:'object'},permission:'installer-extension.read'}]};
 else if(m.method==='echo/invoke')result={marker:'SYNTHETIC_USER_EXTENSION'};
 else continue;
 console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
}
'@
  [IO.File]::WriteAllText((Join-Path $extensionRoot 'entry.mjs'),$extensionCode)
  Invoke-EchoFixture 'plugins.install' @{directory=$extensionRoot;confirmed=$true} | Out-Null
  Invoke-EchoFixture 'plugins.enable' @{id='installer-extension';enabled=$true} | Out-Null
  Invoke-EchoFixture 'external-mcp.save' @{id='deepseek-search';config=@{kind='deepseek';enabled=$false;token='synthetic-installer-credential'}} | Out-Null
  $beforeMcp = @((Invoke-EchoFixture 'system.bootstrap').externalMcpServers | Where-Object id -eq 'deepseek-search')[0] | ConvertTo-Json -Depth 20 -Compress
  $beforePermissions = $role.permissions | ConvertTo-Json -Depth 20 -Compress
  $extensionHash = (Get-FileHash -LiteralPath (Join-Path $extensionRoot 'entry.mjs') -Algorithm SHA256).Hash
  $beforeMessages = (Invoke-EchoFixture 'conversations.messages' @{id=$role.mainConversationId}).messages | ConvertTo-Json -Depth 60 -Compress
  Stop-EchoFixture
  Install-EchoFixture $installerPath $true
  $afterVersion = Start-EchoFixture 'after'
  $cli = Join-Path $installation 'echo-agent.cmd'
  if ($RequireCli -or (Test-Path -LiteralPath $cli)) {
    $doctor = & $cli doctor --json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $doctor.version -ne $afterVersion -or
        $doctor.backend -ne 'ready' -or $doctor.dataDirectory -ne $dataDirectory) { throw 'Installed CLI did not connect to the upgraded runtime' }
  }
  $after = Invoke-EchoFixture 'persona.character.read' @{id='installer-fixture'}
  if (($after.permissions | ConvertTo-Json -Depth 20 -Compress) -ne $beforePermissions) { throw 'Role permissions changed during upgrade' }
  if ((Invoke-EchoFixture 'installer-extension.read').marker -ne 'SYNTHETIC_USER_EXTENSION' -or (Get-FileHash -LiteralPath (Join-Path $extensionRoot 'entry.mjs') -Algorithm SHA256).Hash -ne $extensionHash) { throw 'User extension was changed or did not reload' }
  $afterMcp = @((Invoke-EchoFixture 'system.bootstrap').externalMcpServers | Where-Object id -eq 'deepseek-search')[0] | ConvertTo-Json -Depth 20 -Compress
  if ($afterMcp -ne $beforeMcp) { throw 'External MCP configuration or encrypted credential was changed' }
  if ($after.persona.prompt -ne 'SYNTHETIC_INSTALLER_SENTINEL' -or $after.activity.enabled) { throw 'Role changed during upgrade' }
  $review = @($after.tasks | Where-Object id -eq 'installer-review')[0]
  if ($review.settings.enabled -or $review.settings.mode -ne 'turns' -or $review.settings.rounds -ne 99 -or $review.settings.contextMode -ne 'fresh' -or ($review.settings.memoryOperations -join ',') -ne 'add,update') { throw 'Task settings changed during upgrade' }
  $care = @((Invoke-EchoFixture 'care.status').rules | Where-Object id -eq 'installer-care')[0]
  if ($care.enabled -or $care.mode -ne 'probability' -or $care.probability -ne 17 -or ($care.PSObject.Properties.Name -contains 'blockerIds')) { throw 'Upgrade persisted derived UI options into the canonical task configuration' }
  $afterMessages = (Invoke-EchoFixture 'conversations.messages' @{id=$role.mainConversationId}).messages | ConvertTo-Json -Depth 60 -Compress
  if ($afterMessages -ne $beforeMessages) { throw 'Conversation history changed during upgrade' }
  $core.Refresh(); $cpuBefore=$core.TotalProcessorTime.TotalMilliseconds; $sampleStart=Get-Date
  Start-Sleep -Seconds 5
  $core.Refresh(); $sampleMs=((Get-Date)-$sampleStart).TotalMilliseconds
  $resources=@{scope='Installed backend, no loaded model, no desktop webview';workingSetMiB=[Math]::Round($core.WorkingSet64/1MB,1);privateMiB=[Math]::Round($core.PrivateMemorySize64/1MB,1);cpuPercentOfOneCore=[Math]::Round(($core.TotalProcessorTime.TotalMilliseconds-$cpuBefore)/$sampleMs*100,2)}
  Stop-EchoFixture
  $uninstaller = Join-Path $installation 'uninstall.exe'
  if (-not ([IO.Path]::GetFullPath($uninstaller)).StartsWith($sandbox+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe uninstaller location' }
  $remove = Start-Process -FilePath $uninstaller -ArgumentList @('/S',('_?='+$installation)) -WindowStyle Hidden -PassThru
  if (-not $remove.WaitForExit(300000) -or $remove.ExitCode -ne 0) { throw 'Uninstaller failed' }
  if (Test-Path -LiteralPath (Join-Path $installation 'echo-desktop.exe')) { throw 'Installed executable remains after uninstall' }
  if (-not (Test-Path -LiteralPath (Join-Path $dataDirectory 'echo.sqlite')) -or (Get-Content -LiteralPath (Join-Path $dataDirectory 'retention-marker.txt') -Raw) -ne 'SYNTHETIC_INSTALLER_DATA' -or (Get-FileHash -LiteralPath (Join-Path $extensionRoot 'entry.mjs') -Algorithm SHA256).Hash -ne $extensionHash) { throw 'Uninstall removed user data or extensions' }
  if (Test-Path -LiteralPath ('HKCU:\'+$registryRelative)) { throw 'Uninstall registration remains' }
  $result=@{cleanInstall=$true;upgrade=($beforeVersion -ne $afterVersion);sameVersionRepair=($beforeVersion -eq $afterVersion);beforeVersion=$beforeVersion;afterVersion=$afterVersion;registryLocatedInstall=$true;cliReady=($doctor.backend -eq 'ready');roleAndTasksPreserved=$true;permissionsPreserved=$true;userExtensionReloaded=$true;externalMcpAndCredentialPreserved=$true;canonicalTaskMigrationPreserved=$true;historyPreserved=$true;uninstall=$true;independentDataPreserved=$true;realModelCalls=0;resources=$resources}
  $reportPath=[IO.Path]::GetFullPath($Report)
  New-Item -ItemType Directory -Path (Split-Path -Parent $reportPath) -Force | Out-Null
  $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $reportPath -Encoding utf8
  $result | ConvertTo-Json -Depth 5 -Compress
  $success=$true
} finally {
  if ($core -and -not $core.HasExited) { try { Stop-EchoFixture } catch { Write-Warning 'Fixture runtime is still active; retained the test directory for inspection.' } }
  # Only remove installer preferences created by this fixture, after verifying ownership.
  if ($success -and (Test-Path -LiteralPath $manufacturerKey)) {
    $registered = (Get-Item $manufacturerKey).GetValue('')
    $resolvedRegistry = (Resolve-Path -LiteralPath $manufacturerKey).ProviderPath
    if ($registered -eq $installation -and $resolvedRegistry -eq 'HKEY_CURRENT_USER\Software\echo\Echo Agent') { Remove-Item -LiteralPath $manufacturerKey -Recurse -Force }
    else { throw 'Installer preference ownership changed; retained it.' }
  }
  if ($success) {
    $target=[IO.Path]::GetFullPath($sandbox)
    if (-not $target.StartsWith($testBase+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe fixture cleanup path' }
    Remove-Item -LiteralPath $target -Recurse -Force
  }
}
