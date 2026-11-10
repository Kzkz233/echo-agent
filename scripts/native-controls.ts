import { spawnSync } from 'node:child_process';
import { resolve, sep } from 'node:path';
const base = resolve(import.meta.dirname, '..');
/** Test only: target our native fixture's exact PID and titles, never the user's desktop. */
function operate(
  pid: number,
  text?: string,
  image?: string,
  send = true,
  composer = false,
  command?: string,
) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('Native fixture PID required');
  if (
    image &&
    !['test-results', 'docs/screenshots'].some((p) =>
      resolve(image!).startsWith(resolve(base, p) + sep),
    )
  )
    throw Error('Native screenshot outside owned test paths');
  const encode = (s: string) => Buffer.from(s).toString('base64');
  const code = `Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;using System.Drawing;using System.Drawing.Imaging;
public class EchoOwnedWindowTest{
public delegate bool Callback(IntPtr h,IntPtr p);
[DllImport("user32.dll")]static extern bool EnumWindows(Callback c,IntPtr p);
[DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr h,out uint id);
[DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr h,StringBuilder b,int n);
[DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern IntPtr FindWindowEx(IntPtr p,IntPtr a,string cls,string title);
[DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern bool SetWindowText(IntPtr h,string text);
[DllImport("user32.dll",EntryPoint="SendMessageW",SetLastError=true)]static extern IntPtr SendMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
[DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr h,out Rect r);
[DllImport("user32.dll")]static extern bool PrintWindow(IntPtr h,IntPtr dc,uint flags);
[DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")]static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
[DllImport("gdi32.dll")]static extern bool SetViewportOrgEx(IntPtr dc,int x,int y,IntPtr oldPoint);
struct Rect{public int left,top,right,bottom;}
public static IntPtr Find(int pid,string title){IntPtr found=IntPtr.Zero;EnumWindows((h,p)=>{uint id;GetWindowThreadProcessId(h,out id);if(id==pid){var b=new StringBuilder(300);GetWindowText(h,b,300);if(b.ToString()==title){found=h;return false;}}return true;},IntPtr.Zero);if(found==IntPtr.Zero)throw new Exception("Owned native fixture absent: "+title);return found;}
public static void Reply(int pid,string text,bool send){var h=Find(pid,"Reply to Echo");if(!IsWindowVisible(h))SendMessage(Find(pid,"Echo Native Avatar"),0x205,IntPtr.Zero,IntPtr.Zero);var edit=FindWindowEx(h,IntPtr.Zero,"Edit",null);if(edit==IntPtr.Zero)throw new Exception("Owned reply editor absent");if(FindWindowEx(h,IntPtr.Zero,"Button",null)!=IntPtr.Zero)throw new Exception("Obsolete composer buttons still exist");var buffer=Marshal.StringToHGlobalUni(text);try{SendMessage(edit,0xC,IntPtr.Zero,buffer);}finally{Marshal.FreeHGlobal(buffer);}var length=SendMessage(edit,0xE,IntPtr.Zero,IntPtr.Zero).ToInt32();if(length!=text.Length)throw new Exception("Owned editor text was not set: "+length+"; error "+Marshal.GetLastWin32Error());if(send)SendMessage(edit,0x100,new IntPtr(13),IntPtr.Zero);}
public static void Command(int pid,string action){var h=Find(pid,"Reply to Echo");var edit=FindWindowEx(h,IntPtr.Zero,"Edit",null);if(action=="blur")SendMessage(h,6,IntPtr.Zero,IntPtr.Zero);else if(action=="ime-start")SendMessage(edit,0x10D,IntPtr.Zero,IntPtr.Zero);else if(action=="ime-end")SendMessage(edit,0x10E,IntPtr.Zero,IntPtr.Zero);else if(action=="enter")SendMessage(edit,0x100,new IntPtr(13),IntPtr.Zero);else if(action=="escape")SendMessage(edit,0x100,new IntPtr(27),IntPtr.Zero);else throw new Exception("Unknown owned command");}
public static void Snapshot(int pid,string path,bool composer){SetThreadDpiAwarenessContext(new IntPtr(-4));var h=Find(pid,composer?"Reply to Echo":"Echo Native Bubble");Rect r;GetWindowRect(h,out r);using(var b=new Bitmap(r.right-r.left,r.bottom-r.top,PixelFormat.Format32bppArgb)){using(var g=Graphics.FromImage(b)){var dc=g.GetHdc();try{if(!PrintWindow(h,dc,2))throw new Exception("Window capture failed");if(composer){var edit=FindWindowEx(h,IntPtr.Zero,"Edit",null);Rect e;GetWindowRect(edit,out e);SetViewportOrgEx(dc,e.left-r.left,e.top-r.top,IntPtr.Zero);PrintWindow(edit,dc,0);}}finally{g.ReleaseHdc(dc);}}b.Save(path,ImageFormat.Png);}}
}
'@ -ReferencedAssemblies System.Drawing
${command ? `[EchoOwnedWindowTest]::Command(${pid},'${command}')` : text !== undefined ? `[EchoOwnedWindowTest]::Reply(${pid},[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encode(text)}')),${send ? '$true' : '$false'})` : `[EchoOwnedWindowTest]::Snapshot(${pid},[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encode(image!)}')),${composer ? '$true' : '$false'})`}`;
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', code],
    { windowsHide: true, encoding: 'utf8', timeout: 20000 },
  );
  if (result.status !== 0) throw Error(result.stderr || 'Owned native UI action failed');
}
export const replyToNative = (pid: number, text: string) => operate(pid, text);
export const snapshotNative = (pid: number, path: string) => operate(pid, undefined, path);
export const draftToNative = (pid: number, text: string) => operate(pid, text, undefined, false);
export const snapshotNativeComposer = (pid: number, path: string) =>
  operate(pid, undefined, path, false, true);
export const nativeComposerCommand = (
  pid: number,
  command: 'blur' | 'ime-start' | 'ime-end' | 'enter' | 'escape',
) => operate(pid, undefined, undefined, false, true, command);
