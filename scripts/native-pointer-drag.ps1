param([int]$TargetProcessId,[string]$ExpectedExecutable,[double]$StartX,[double]$StartY,[double]$EndX,[double]$EndY,[double]$ViewportWidth,[double]$ViewportHeight)
$ErrorActionPreference='Stop'
$targetProcess=Get-Process -Id $TargetProcessId
if([IO.Path]::GetFullPath($targetProcess.Path) -ne [IO.Path]::GetFullPath($ExpectedExecutable)){throw 'Native fixture executable mismatch'}
if(-not [IO.Path]::GetFullPath($ExpectedExecutable).StartsWith(([IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) 'EchoTests'))+'\'),[StringComparison]::OrdinalIgnoreCase)){throw 'Native pointer tests require an isolated EchoTests fixture'}
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class EchoPointerFixture {
 [StructLayout(LayoutKind.Sequential)] public struct Point {public int X,Y;}
 [StructLayout(LayoutKind.Sequential)] public struct Rect {public int Left,Top,Right,Bottom;}
 public delegate bool WindowCallback(IntPtr hwnd,IntPtr data);
 [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback,IntPtr data);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd,out Rect rect);
 [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd,ref Point point);
 [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
 [DllImport("user32.dll")] static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern void mouse_event(uint flags,uint dx,uint dy,uint data,UIntPtr extra);
 public static void Drag(int target,double x,double y,double endX,double endY,double width,double height) {
  if(width<=0||height<=0||x<0||y<0||endX<0||endY<0||x>=width||endX>=width||y>=height||endY>=height)throw new Exception("Drag endpoints must stay inside the fixture viewport");
  var dpi=SetThreadDpiAwarenessContext(new IntPtr(-4));var foreground=GetForegroundWindow();Point cursor;GetCursorPos(out cursor);bool pressed=false;
  try {IntPtr window=IntPtr.Zero;EnumWindows((hwnd,data)=>{uint pid;GetWindowThreadProcessId(hwnd,out pid);if(pid==target&&IsWindowVisible(hwnd)){window=hwnd;return false;}return true;},IntPtr.Zero);
   if(window==IntPtr.Zero)throw new Exception("Fixture window is not visible");Rect bounds;Point origin=new Point();if(!GetClientRect(window,out bounds)||!ClientToScreen(window,ref origin))throw new Exception("Fixture geometry unavailable");
   double sx=(bounds.Right-bounds.Left)/width,sy=(bounds.Bottom-bounds.Top)/height;
   int ax=origin.X+(int)Math.Round(x*sx),ay=origin.Y+(int)Math.Round(y*sy),bx=origin.X+(int)Math.Round(endX*sx),by=origin.Y+(int)Math.Round(endY*sy);
   SetForegroundWindow(window);Thread.Sleep(200);SetCursorPos(ax,ay);mouse_event(2,0,0,0,UIntPtr.Zero);pressed=true;Thread.Sleep(550);
   for(int i=1;i<=24;i++){SetCursorPos(ax+(bx-ax)*i/24,ay+(by-ay)*i/24);Thread.Sleep(20);}Thread.Sleep(150);mouse_event(4,0,0,0,UIntPtr.Zero);pressed=false;Thread.Sleep(400);
  }finally{if(pressed)mouse_event(4,0,0,0,UIntPtr.Zero);SetCursorPos(cursor.X,cursor.Y);if(foreground!=IntPtr.Zero)SetForegroundWindow(foreground);SetThreadDpiAwarenessContext(dpi);}
 }
}
'@
[EchoPointerFixture]::Drag($TargetProcessId,$StartX,$StartY,$EndX,$EndY,$ViewportWidth,$ViewportHeight)
