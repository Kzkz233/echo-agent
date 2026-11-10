import { spawnSync } from 'node:child_process';
import type { Browser } from '@playwright/test';

/** Raise only an owned acceptance fixture, without activating another application. */
export async function showFixture(browser: Browser, prefix: string) {
  if (
    !['Allowed fixture', 'Private fixture', 'Allowed Echo entertainment fixture'].includes(prefix)
  )
    throw Error('Only synthetic fixture windows may be raised');
  const session = await browser.newBrowserCDPSession();
  const info = await session.send('SystemInfo.getProcessInfo');
  const pid = info.processInfo.find((p) => p.type === 'browser')?.id;
  await session.detach();
  if (!Number.isSafeInteger(pid) || !pid || pid < 1) throw Error('Fixture browser PID unavailable');
  const script = `Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class EchoOwnedFixture {
  delegate bool EnumProc(IntPtr hwnd,IntPtr data);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback,IntPtr data);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
  [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int length);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd,IntPtr after,int x,int y,int cx,int cy,uint flags);
  public static int Raise(uint owner,string prefix) {int found=0;EnumWindows((hwnd,data)=>{uint pid;GetWindowThreadProcessId(hwnd,out pid);if(pid!=owner)return true;var title=new StringBuilder(1024);GetWindowText(hwnd,title,title.Capacity);if(title.ToString().StartsWith(prefix,StringComparison.Ordinal)){if(SetWindowPos(hwnd,new IntPtr(-1),0,0,0,0,0x0013))found++;}return true;},IntPtr.Zero);return found;}
}
'@
$fixtureCount=[EchoOwnedFixture]::Raise([uint32]$env:ECHO_TEST_BROWSER_PID,$env:ECHO_TEST_WINDOW_PREFIX)
if($fixtureCount -lt 1){throw 'Owned fixture window not found'}
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ECHO_TEST_BROWSER_PID: String(pid), ECHO_TEST_WINDOW_PREFIX: prefix },
  });
  if (result.status !== 0) throw Error(result.stderr || 'Could not show owned fixture');
}
