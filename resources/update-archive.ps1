param([Parameter(Mandatory=$true)][string]$Archive, [Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $root) { throw 'Extraction destination already exists' }
$zip = [IO.Compression.ZipFile]::OpenRead($Archive)
try {
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  [long]$total = 0
  if ($zip.Entries.Count -gt 60000) { throw 'Too many archive entries' }
  foreach ($entry in $zip.Entries) {
    $name = $entry.FullName
    if ($name.Contains('\') -or $name.Contains(':') -or $name.StartsWith('/') -or
        !($name -eq 'update.json' -or $name.StartsWith('app/'))) { throw 'Invalid archive path' }
    foreach ($part in $name.TrimEnd('/').Split('/')) {
      if ($part -notmatch '^[\w@().+ -]+$' -or $part -match '[. ]$' -or
          $part -match '^(con|prn|aux|nul|com\d|lpt\d)(\.|$)') { throw 'Invalid archive path component' }
    }
    if (!$seen.Add($name.TrimEnd('/'))) { throw 'Duplicate archive path' }
    $kind = ($entry.ExternalAttributes -shr 16) -band 61440
    if ($kind -ne 0 -and $kind -ne 32768 -and $kind -ne 16384) { throw 'Linked or unsupported archive entry' }
    $total += $entry.Length
    if ($total -gt 4294967296 -or $entry.Length -gt 2147483648) { throw 'Archive too large' }
    $target = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $name))
    if (!$target.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path outside destination' }
  }
  $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($root))
  if ($drive.AvailableFreeSpace -lt ($total + 134217728)) { throw 'Insufficient disk space' }
  [IO.Directory]::CreateDirectory($root) | Out-Null
  foreach ($entry in $zip.Entries) {
    $target = [IO.Path]::Combine($root, $entry.FullName)
    if ($entry.FullName.EndsWith('/')) { [IO.Directory]::CreateDirectory($target) | Out-Null; continue }
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
  }
} finally { $zip.Dispose() }
