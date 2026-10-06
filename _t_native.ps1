$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    public delegate bool EnumProc(IntPtr h, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetWindowTextW")]
    public static extern int GetWindowTextW(IntPtr h, StringBuilder sb, int max);
    public static IntPtr Find(string needle) {
        IntPtr hit = IntPtr.Zero;
        var sb = new StringBuilder(512);
        EnumWindows(delegate(IntPtr h, IntPtr l) {
            sb.Length = 0; GetWindowTextW(h, sb, 512);
            if (sb.ToString().IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) { hit = h; return false; }
            return true;
        }, IntPtr.Zero);
        return hit;
    }
}
"@
Add-Type -TypeDefinition (Get-Content -Raw -LiteralPath "$PSScriptRoot\uia-native.cs") `
    -ReferencedAssemblies UIAutomationClient, UIAutomationTypes, WindowsBase, System.Drawing

$hwnd = [Win]::Find('Parcel Tracker')
"свежий hwnd: $hwnd"
$h = $hwnd.ToInt64()

"=== RunTreeByHwnd (известно, что работает) ==="
$t = [UiaNative]::RunTreeByHwnd(6000, $h, 4, 60, $true)
"длина=$($t.Data.Length) статус=$($t.Status)"

"=== RunSearchByHwnd type=Button name=Search ==="
$r = [UiaNative]::RunSearchByHwnd(6000, $h, 'Search', 'Button', '', 8, 3)
"длина=$($r.Data.Length) статус=$($r.Status)"
$r.Data

"=== RunSearchByHwnd name=Search ==="
$r2 = [UiaNative]::RunSearchByHwnd(6000, $h, 'Search', '', '', 8, 3)
"длина=$($r2.Data.Length)"
$r2.Data

"=== RunSearchByHwnd automationId=searchBox ==="
$r3 = [UiaNative]::RunSearchByHwnd(6000, $h, '', '', 'searchBox', 8, 3)
"длина=$($r3.Data.Length)"
$r3.Data