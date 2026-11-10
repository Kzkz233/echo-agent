import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { updateManifestSchema } from '../packages/contracts/update.ts';
import { buildSchema } from '../packages/contracts/build.ts';
import { fileInventory } from '../packages/kernel/update-files.ts';

/** Input is an audited portable application tree, never an installed data directory. */
export async function createUpdatePackage(portable: string, destination: string) {
  const parent = dirname(resolve(destination));
  await mkdir(parent, { recursive: true });
  const scratch = await mkdtemp(join(parent, '.update-package-'));
  try {
    const app = resolve(portable);
    const build = buildSchema.parse(
      JSON.parse(await readFile(join(app, 'runtime/dist/build-info.json'), 'utf8')),
    );
    if (build.edition === 'development')
      throw Error('A development build cannot be released as an update');
    const manifest = updateManifestSchema.parse({
      format: 'echo-update-v1',
      platform: 'win32-x64',
      build,
      files: await fileInventory(app),
    });
    await writeFile(join(scratch, 'update.json'), JSON.stringify(manifest));
    // Pass paths as arguments. No paths or content are interpolated into PowerShell code.
    const script = join(parent, '.zip-update.ps1');
    await writeFile(
      script,
      `param([string]$Source,[string]$Destination,[string]$Manifest)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$inventory = Get-Content -LiteralPath $Manifest -Raw | ConvertFrom-Json
$zip = [IO.Compression.ZipFile]::Open($Destination,[IO.Compression.ZipArchiveMode]::Create)
try {
  [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$Manifest,'update.json',[IO.Compression.CompressionLevel]::Optimal) | Out-Null
  foreach ($row in $inventory.files) {
    $file = [IO.Path]::Combine($Source,$row.path)
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,$file,('app/' + $row.path),[IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally { $zip.Dispose() }
`,
    );
    try {
      const child = spawn(
        join(
          process.env.SystemRoot ?? 'C:\\Windows',
          'System32/WindowsPowerShell/v1.0/powershell.exe',
        ),
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          script,
          '-Source',
          app,
          '-Destination',
          resolve(destination),
          '-Manifest',
          join(scratch, 'update.json'),
        ],
        { windowsHide: true, stdio: 'inherit' },
      );
      await new Promise<void>((done, reject) => {
        child.once('error', reject);
        child.once('exit', (code) =>
          code === 0 ? done() : reject(Error('Update package creation failed')),
        );
      });
    } finally {
      await rm(script, { force: true });
    }
    return manifest;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
