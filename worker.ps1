$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding  = New-Object System.Text.UTF8Encoding($false)

$ErrorActionPreference = 'Continue'

# Процесс должен объявить себя DPI-aware ДО любых UI-вызовов. Иначе на
# мониторе с масштабированием (125%, 150%) координаты из UIA и OCR приходят
# в логических единицах, а SendInput жмёт в физических пикселях, и клик уезжает
# мимо цели на десятки пикселей. Проверено: без этого вызов процесс помечается
# как DPI_UNAWARE.
if (-not ("DpiFix" -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DpiFix {
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("shcore.dll")] static extern int SetProcessDpiAwareness(int a);
  public static string Apply() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return "per-monitor-v2"; } catch { }
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-3))) return "per-monitor-v1"; } catch { }
    try { if (SetProcessDpiAwareness(2) == 0) return "per-monitor"; } catch { }
    return "unaware";
  }
}
'@
}
$DpiMode = [DpiFix]::Apply()

if (-not ("DeskMcp" -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

public class DeskMcp {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
    [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] p, int size);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
    [DllImport("user32.dll", EntryPoint = "GetWindowThreadProcessId")]
    static extern uint GetWindowThreadProcessIdPid(IntPtr h, out int pid);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int i);
    [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
    [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
    [DllImport("user32.dll")] public static extern short GetKeyState(int vKey);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }
    // PrintWindow с PW_RENDERFULLCONTENT (0x2) заставляет приложение
    // перерисовать содержимое в переданный DC. Обычный BitBlt к окну
    // возвращает то, что лежит в композиторе, а для перекрытых и
    // развёрнутых окон — пустоту.
    public static System.Drawing.Bitmap CaptureWindow(IntPtr h) {
        RECT r;
        if (h == IntPtr.Zero || !GetWindowRect(h, out r)) return null;
        int w = r.Right - r.Left, ht = r.Bottom - r.Top;
        if (w <= 0 || ht <= 0) return null;
        var bmp = new System.Drawing.Bitmap(w, ht, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        using (var g = System.Drawing.Graphics.FromImage(bmp)) {
            IntPtr hdc = g.GetHdc();
            try { PrintWindow(h, hdc, 2); }
            finally { g.ReleaseHdc(hdc); }
        }
        return bmp;
    }

    public static System.Drawing.Rectangle WindowBounds(IntPtr h) {
        RECT r;
        if (!GetWindowRect(h, out r)) return new System.Drawing.Rectangle(0, 0, 0, 0);
        return new System.Drawing.Rectangle(r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top);
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Explicit, Size = 40)]
    public struct INPUT {
        [FieldOffset(0)] public uint type;
        [FieldOffset(8)] public KEYBDINPUT ki;
    }

    public const uint LEFTDOWN   = 0x0002, LEFTUP   = 0x0004;
    public const uint RIGHTDOWN = 0x0008, RIGHTUP   = 0x0010;
    public const uint MIDDLEDOWN = 0x0020, MIDDLEUP   = 0x0040;
    public const uint WHEEL     = 0x0800, HWHEEL   = 0x01000;
    public const uint MOVE      = 0x0001, ABSOLUTE = 0x8000;
    public const uint KEYEVENTF_UNICODE = 0x0004, KEYEVENTF_KEYUP = 0x0002;
    public const uint INPUT_KEYBOARD = 1;

    public static int Size() { return Marshal.SizeOf(typeof(INPUT)); }

    public static void MoveTo(int x, int y) { SetCursorPos(x, y); }

    public static void Click(string button, int count) {
        uint down, up;
        if (button == "right")       { down = RIGHTDOWN; up = RIGHTUP; }
        else if (button == "middle"){ down = MIDDLEDOWN; up = MIDDLEUP; }
        else                        { down = LEFTDOWN;   up = LEFTUP; }
        for (int i = 0; i < count; i++) {
            mouse_event(down, 0, 0, 0, IntPtr.Zero);
            System.Threading.Thread.Sleep(30);
            mouse_event(up, 0, 0, 0, IntPtr.Zero);
            if (i + 1 < count) System.Threading.Thread.Sleep(90);
        }
    }

    public static void ButtonDown(string button) {
        uint down;
        if (button == "right")        down = RIGHTDOWN;
        else if (button == "middle") down = MIDDLEDOWN;
        else                          down = LEFTDOWN;
        mouse_event(down, 0, 0, 0, IntPtr.Zero);
    }

    public static void ButtonUp(string button) {
        uint up;
        if (button == "right")        up = RIGHTUP;
        else if (button == "middle") up = MIDDLEUP;
        else                          up = LEFTUP;
        mouse_event(up, 0, 0, 0, IntPtr.Zero);
    }

    public static void Drag(int x1, int y1, int x2, int y2, int steps, int stepMs) {
        SetCursorPos(x1, y1);
        System.Threading.Thread.Sleep(60);
        mouse_event(LEFTDOWN, 0, 0, 0, IntPtr.Zero);
        System.Threading.Thread.Sleep(60);
        for (int i = 1; i <= steps; i++) {
            int x = x1 + (x2 - x1) * i / steps;
            int y = y1 + (y2 - y1) * i / steps;
            SetCursorPos(x, y);
            System.Threading.Thread.Sleep(stepMs);
        }
        System.Threading.Thread.Sleep(60);
        mouse_event(LEFTUP, 0, 0, 0, IntPtr.Zero);
    }

    public static void ScrollWheel(int dx, int dy) {
        if (dy != 0) mouse_event(WHEEL, 0, 0, unchecked((uint)dy), IntPtr.Zero);
        if (dx != 0) mouse_event(HWHEEL, 0, 0, unchecked((uint)dx), IntPtr.Zero);
    }

    public static int TypeUnicode(string s) {
        int size = Size(), sent = 0;
        foreach (char c in s) {
            INPUT d = new INPUT { type = INPUT_KEYBOARD };
            d.ki = new KEYBDINPUT { wScan = (ushort)c, dwFlags = KEYEVENTF_UNICODE, dwExtraInfo = IntPtr.Zero };
            INPUT u = new INPUT { type = INPUT_KEYBOARD };
            u.ki = new KEYBDINPUT { wScan = (ushort)c, dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, dwExtraInfo = IntPtr.Zero };
            sent += (int)SendInput(2, new INPUT[] { d, u }, size);
        }
        return sent;
    }

    public static int VKey(ushort vk, bool up) {
        INPUT i = new INPUT { type = INPUT_KEYBOARD };
        i.ki = new KEYBDINPUT { wVk = vk, dwFlags = up ? KEYEVENTF_KEYUP : 0, dwExtraInfo = IntPtr.Zero };
        return (int)SendInput(1, new INPUT[] { i }, Size());
    }

    public static int PidOf(IntPtr h) {
        int pid = 0;
        if (GetWindowThreadProcessIdPid(h, out pid) == 0) return 0;
        return pid;
    }

    public static bool KeyDown(int vk) { return (GetKeyState(vk) & 0x8000) != 0; }

    public static bool Focus(IntPtr h) {
        if (h == IntPtr.Zero) return false;
        IntPtr fg = GetForegroundWindow();
        uint fgThread = GetWindowThreadProcessId(fg, IntPtr.Zero);
        uint myThread = GetCurrentThreadId();
        bool attached = false;
        if (fgThread != myThread && fgThread != 0) {
            attached = AttachThreadInput(myThread, fgThread, true);
        }
        // try/finally обязателен: без него исключение между Attach и Detach
        // оставит потоки ввода сцепленными, и последующие клики будут уходить
        // не туда — вплоть до залипания модификаторов.
        try {
            ShowWindow(h, 9);
            BringWindowToTop(h);
            bool ok = SetForegroundWindow(h);
            SetActiveWindow(h);
            return ok;
        } finally {
            if (attached) AttachThreadInput(myThread, fgThread, false);
        }
    }
}
'@ -ReferencedAssemblies System.Drawing
}

if (-not ("DeskMcp" -as [type])) { throw "Класс DeskMcp не скомпилировался — воркер не может работать" }


if (-not ("VDesk" -as [type])) {
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

[ComImport, Guid("2E910C3F-9F48-4B2F-BB99-4B87A8A89A7D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IVirtualDesktopManager {
    [PreserveSig] int IsWindowOnDesktop(IntPtr hwnd, [In] ref Guid id);
    [PreserveSig] int MoveWindowToDesktop(IntPtr hwnd, [In] ref Guid id);
    [PreserveSig] IntPtr FindWindowByProcessId(uint pid, [MarshalAs(UnmanagedType.LPWStr)] string caption);
    [PreserveSig] Guid GetWindowDesktopId(IntPtr hwnd);
    [PreserveSig] int SetWindowDesktopId(IntPtr hwnd, [In] ref Guid id);
    [PreserveSig] uint GetDesktopCount();
    [PreserveSig] Guid GetDesktopByIndex(uint index);
    [PreserveSig] Guid CreateDesktop();
    [PreserveSig] int CloseDesktop([In] ref Guid id);
    [PreserveSig] int SwitchDesktop([In] ref Guid id);
}

public static class VDesk {
    static readonly Guid CLSID = new Guid("A5CD92FF-29BE-454C-8D04-D8285FB3F1B5");
    static readonly Guid IID = new Guid("2E910C3F-9F48-4B2F-BB99-4B87A8A89A7D");
    static bool _loaded = false;

    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
    static extern IntPtr LoadLibraryW(string fileName);
    [System.Runtime.InteropServices.DllImport("ole32.dll")]
    static extern int CoCreateInstance(ref Guid clsid, IntPtr outer, uint context, ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object o);

    public static IVirtualDesktopManager Get() {
        // Класс живёт в VirtualDesktopManager.dll и не зарегистрирован в реестре:
        // Type.GetTypeFromCLSID падает с REGDB_E_CLASSNOTREG, пока DLL не
        // загружена. Под Windows 10/11 она лежит в System32.
        if (!_loaded) {
            IntPtr h = LoadLibraryW("VirtualDesktopManager.dll");
            if (h == IntPtr.Zero) {
                throw new COMException("VirtualDesktopManager.dll не найдена (WinErr " + Marshal.GetLastWin32Error() + ")");
            }
            _loaded = true;
        }
        Guid c = CLSID, i = IID;
        object o;
        int hr = CoCreateInstance(ref c, IntPtr.Zero, 1, ref i, out o);
        if (hr != 0) throw new COMException("CoCreateInstance вернул 0x" + hr.ToString("X8"));
        return (IVirtualDesktopManager)o;
    }

    public static List<string> List() {
        var m = Get();
        var res = new List<string>();
        uint n = m.GetDesktopCount();
        for (uint i = 0; i < n; i++) res.Add(m.GetDesktopByIndex(i).ToString());
        return res;
    }

    public static string Create() { return Get().CreateDesktop().ToString(); }

    public static void Switch(string guid) {
        Guid g = new Guid(guid);
        int hr = Get().SwitchDesktop(ref g);
        if (hr != 0) throw new COMException("SwitchDesktop вернул HRESULT 0x" + hr.ToString("X8"));
    }

    public static void Close(string guid) {
        Guid g = new Guid(guid);
        int hr = Get().CloseDesktop(ref g);
        if (hr != 0) throw new COMException("CloseDesktop вернул HRESULT 0x" + hr.ToString("X8"));
    }

    public static string OfWindow(IntPtr hwnd) { return Get().GetWindowDesktopId(hwnd).ToString(); }

    public static void MoveWindowTo(IntPtr hwnd, string guid) {
        Guid g = new Guid(guid);
        int hr = Get().MoveWindowToDesktop(hwnd, ref g);
        if (hr != 0) throw new COMException("MoveWindowToDesktop вернул HRESULT 0x" + hr.ToString("X8"));
    }
}
"@
}

$script:BenchProc = $null

function Get-BenchLog { Join-Path $env:TEMP 'desk-mcp-bench.log' }

function Start-Bench {
    $script:BenchProc = Start-Process -FilePath 'powershell.exe' `
        -ArgumentList '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA', '-File', "`"$PSScriptRoot\bench.ps1`"" `
        -PassThru -WindowStyle Hidden
    return $script:BenchProc.Id
}

function Read-BenchLog {
    $f = Get-BenchLog
    if (-not (Test-Path $f)) { return '' }
    return [System.IO.File]::ReadAllText($f, [System.Text.Encoding]::UTF8)
}

function Stop-Bench {
    if ($script:BenchProc -and -not $script:BenchProc.HasExited) { $script:BenchProc.Kill() }
    $script:BenchProc = $null
}
function Get-DeskInfo {
    $ids = [VDesk]::List()
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    return [ordered]@{
        count = $ids.Count
        desktops = @($ids | ForEach-Object { [ordered]@{ id = $_ } })
        screen = [ordered]@{ x = $vs.Left; y = $vs.Top; w = $vs.Width; h = $vs.Height }
    }
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Runtime.WindowsRuntime

if (-not ("MsTree" -as [type])) {
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class MsNode {
    public string name = "";
    public string role = "";
    public int roleCode = 0;
    public int x, y, w, h;
    public int childCount = 0;
    public int usefulCount = 0;
    public List<MsNode> children = new List<MsNode>();
}

public static class MsTree {
    const uint OBJID_CLIENT = 0xFFFFFFFC;

    [DllImport("oleacc.dll")]
    static extern int AccessibleObjectFromWindow(IntPtr hwnd, uint dwId,
        ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out object ppvObject);

    [DllImport("oleacc.dll", CharSet = CharSet.Unicode)]
    static extern int GetRoleTextW(uint role, StringBuilder roleText, uint roleTextLength);

    [DllImport("oleacc.dll")]
    static extern int WindowFromPointSync(int x, int y, out IntPtr phwnd);

    public static string RoleText(int code) {
        var sb = new StringBuilder(256);
        try { if (GetRoleTextW((uint)code, sb, 256) == 0) return "?"; } catch { return "?"; }
        return sb.ToString();
    }

    static Accessibility.IAccessible FromWindow(IntPtr hwnd) {
        if (hwnd == IntPtr.Zero) return null;
        Guid iid = new Guid("618736E0-3C3D-11CF-810C-00AA00389B71");
        object o;
        try {
            if (AccessibleObjectFromWindow(hwnd, OBJID_CLIENT, ref iid, out o) != 0 || o == null) return null;
            return (Accessibility.IAccessible)o;
        } catch { return null; }
    }

    static bool IsInteractive(int role) {
        switch (role) {
            case 2: case 3: case 4: case 5: case 7: case 8:
            case 12: case 14: case 21: case 22: case 23: case 24:
            case 25: case 28: case 29: case 30: case 33: case 36:
            case 37: case 38: case 39: case 40: case 41: case 42:
            case 43: case 44: case 45: case 46: case 47: case 48:
            case 60: case 61: case 64:
                return true;
            default: return false;
        }
    }

    static bool IsWrapper(MsNode n) {
        int r = n.roleCode;
        return string.IsNullOrEmpty(n.name)
               && (r == 16 || r == 15 || r == 10 || r == 20 || r == 0);
    }

    static void AddFlattened(List<MsNode> into, MsNode n) {
        if (n == null) return;
        if (IsWrapper(n) && n.children.Count > 0) {
            for (int i = 0; i < n.children.Count; i++) AddFlattened(into, n.children[i]);
        } else {
            into.Add(n);
        }
    }

    static MsNode Build(Accessibility.IAccessible acc, int depth, int maxDepth,
                        int maxElements, bool interactiveOnly, ref int counter) {
        if (acc == null || depth > maxDepth || counter >= maxElements) return null;

        var node = new MsNode();
        try { node.childCount = acc.accChildCount; } catch { return null; }
        try { node.name = acc.get_accName(0) ?? ""; } catch { }
        try { node.roleCode = Convert.ToInt32(acc.get_accRole(0)); } catch { }
        try { node.role = RoleText(node.roleCode); } catch { }
        try {
            int l, t, w, h;
            acc.accLocation(out l, out t, out w, out h, 0);
            node.x = l; node.y = t; node.w = w; node.h = h;
        } catch { }

        if (!IsWrapper(node)) {
            if (counter >= maxElements) return null;
            counter++;
        }

        var kids = new List<MsNode>();
        if (depth < maxDepth && node.childCount > 0) {
            int lim = Math.Min(node.childCount, Math.Max(0, maxElements - counter));
            for (int i = 1; i <= lim; i++) {
                if (counter >= maxElements) break;
                try {
                    object ch = acc.get_accChild(i);
                    if (ch == null) continue;
                    Accessibility.IAccessible sub = ch as Accessibility.IAccessible;
                    if (sub != null) {
                        MsNode cn = Build(sub, depth + 1, maxDepth, maxElements, interactiveOnly, ref counter);
                        AddFlattened(kids, cn);
                    } else {
                        counter++;
                        var leaf = new MsNode();
                        try { leaf.name = acc.get_accName(i) ?? ""; } catch { }
                        try { leaf.roleCode = Convert.ToInt32(acc.get_accRole(i)); } catch { }
                        try { leaf.role = RoleText(leaf.roleCode); } catch { }
                        try {
                            int l, t, w, h;
                            acc.accLocation(out l, out t, out w, out h, i);
                            leaf.x = l; leaf.y = t; leaf.w = w; leaf.h = h;
                        } catch { }
                        if (!interactiveOnly || IsInteractive(leaf.roleCode) || leaf.roleCode == 0) AddFlattened(kids, leaf);
                    }
                } catch { }
            }
        }
        node.usefulCount = 0;
        foreach (MsNode kid in kids) {
            int r = kid.roleCode;
            bool skip = (r == 16 || r == 15 || r == 10 || r == 0);
            if (!skip && !string.IsNullOrEmpty(kid.name)) node.usefulCount++;
            node.usefulCount += kid.usefulCount;
        }
        node.children = kids;
        return node;
    }

    public static MsNode TreeForWindow(IntPtr hwnd, int maxDepth, int maxElements, bool interactiveOnly) {
        Accessibility.IAccessible acc = FromWindow(hwnd);
        if (acc == null) return null;
        int counter = 0;
        return Build(acc, 0, maxDepth, maxElements, interactiveOnly, ref counter);
    }

    public static List<MsNode> ChainAtPoint(int x, int y, int depth) {
        var outList = new List<MsNode>();
        IntPtr hwnd;
        try {
            if (WindowFromPointSync(x, y, out hwnd) != 0) return outList;
        } catch { return outList; }
        Accessibility.IAccessible acc = FromWindow(hwnd);
        if (acc == null) return outList;
        int counter = 0;
        MsNode root = Build(acc, 0, depth, 8, false, ref counter);
        if (root != null) outList.Add(root);
        return outList;
    }
}
"@ -ReferencedAssemblies Accessibility
}

function Get-MsaaTree {
    param([string]$TitleLike, [int]$MaxDepth, [int]$MaxElements, [bool]$InteractiveOnly)
    $result = @()
    $script:MsaaUseful = 0
    foreach ($w in Get-WindowList) {
        if ($TitleLike -ne '' -and $w.title -notlike "*$(Escape-Like $TitleLike)*") { continue }
        if (-not $w.visible) { continue }
        $p = Get-Process -Id $w.process -ErrorAction SilentlyContinue
        if (-not $p -or $p.MainWindowHandle -eq 0) { continue }
        try {
            $node = [MsTree]::TreeForWindow($p.MainWindowHandle, $MaxDepth, $MaxElements, $InteractiveOnly)
            if ($node) {
                $result += ,(Convert-MsaaNode $node)
                $script:MsaaUseful += $node.usefulCount
            }
        } catch { }
    }
    return , @($result)
}

function Convert-MsaaNode($n) {
    $node = [ordered]@{
        name      = (Trunc $n.name)
        type      = $n.role
        roleCode  = $n.roleCode
        childCount= $n.childCount
        rect      = [ordered]@{ x = [int]$n.x; y = [int]$n.y; w = [int]$n.w; h = [int]$n.h }
    }
    $kids = @()
    if ($n.children -and $n.children.Count -gt 0) {
        foreach ($c in $n.children) { $kids += ,(Convert-MsaaNode $c) }
    }
    if ($kids.Count -gt 0) { $node['children'] = $kids }
    return , $node
}



function ConvertTo-Utf8Base64([string]$s) {
    return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($s))
}

function Send-Response($id, $ok, $data, $error) {
    $obj = [ordered]@{ id = $id; ok = $ok }
    if ($ok) { $obj['data'] = $data } else { $obj['error'] = $error }
    $json = $obj | ConvertTo-Json -Depth 32 -Compress
    [Console]::Out.WriteLine("B64:" + (ConvertTo-Utf8Base64 $json))
    [Console]::Out.Flush()
}

function Rect($r) {
    $out = [ordered]@{ x = 0; y = 0; w = 0; h = 0 }
    if ($null -eq $r) { return $out }
    foreach ($k in 'X', 'Y', 'Width', 'Height') {
        $v = 0
        try {
            $raw = $r.$k
            $d = [double]$raw
            if ([double]::IsInfinity($d) -or [double]::IsNaN($d)) { $d = 0 }
            if ([Math]::Abs($d) -gt 200000000) { $d = 0 }
            $v = [int][Math]::Round($d)
        } catch { $v = 0 }
        $out[[string]$k.Substring(0,1).ToLower()] = $v
    }
    return $out
}

function Escape-Like([string]$s) {
    if ($null -eq $s) { return '' }
    return $s -replace '([\[\]\*\?])', '`$1'
}

function Trunc($s, [int]$max = 200) {
    if ($null -eq $s) { return '' }
    $t = [string]$s
    $t = $t -replace '\s+', ' '
    if ($t.Length -le $max) { return $t }
    return $t.Substring(0, $max) + '…'
}

function Get-Vk([string]$name) {
    switch ($name.ToLowerInvariant()) {
        'return'        { return 0x0D }
        'enter'         { return 0x0D }
        'esc'           { return 0x1B }
        'escape'        { return 0x1B }
        'tab'           { return 0x09 }
        'backspace'     { return 0x08 }
        'delete'        { return 0x2E }
        'del'           { return 0x2E }
        'insert'        { return 0x2D }
        'space'         { return 0x20 }
        'home'          { return 0x24 }
        'end'           { return 0x23 }
        'pageup'        { return 0x21 }
        'pgup'          { return 0x21 }
        'pagedown'      { return 0x22 }
        'pgdn'          { return 0x22 }
        'up'            { return 0x26 }
        'down'          { return 0x28 }
        'left'          { return 0x25 }
        'right'         { return 0x27 }
        'ctrl'          { return 0x11 }
        'control'       { return 0x11 }
        'shift'         { return 0x10 }
        'alt'           { return 0x12 }
        'win'           { return 0x5B }
        'lwin'          { return 0x5B }
        'apps'          { return 0x5D }
        'capslock'      { return 0x14 }
        'printscreen'   { return 0x2C }
        'scrolllock'    { return 0x91 }
        'pause'         { return 0x13 }
        'numlock'       { return 0x90 }
        default {
            if ($name -match '^(?:f)([1-9]|1[0-9]|2[0-4])$') { return 0x6F + [int]$Matches[1] }
            if ($name.Length -eq 1) {
                $c = $name.ToUpperInvariant()
                if ($c -match '^[A-Z0-9]$') { return [byte][char]$c }
            }
            return $null
        }
    }
}


function Get-WindowList {
    $result = @()
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Window)
    foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {
        try {
            $r = $w.Current.BoundingRectangle
            $result += [ordered]@{
                title   = $w.Current.Name
                process = $w.Current.ProcessId
                class   = $w.Current.ClassName
                rect    = Rect $r
                visible = [DeskMcp]::IsWindowVisible([IntPtr]$w.Current.NativeWindowHandle)
            }
        } catch { }
    }
    return $result
}

function Find-WindowByTitle([string]$like, [int]$timeoutSec) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ($true) {
        $pat = "*$(Escape-Like $like)*"
        $w = Get-WindowList | Where-Object { $_.title -like $pat -and $_.visible } | Select-Object -First 1
        if ($w) {
            $h = (Get-Process -Id $w.process -ErrorAction SilentlyContinue)
            return $w
        }
        if ((Get-Date) -ge $deadline) { return $null }
        Start-Sleep -Milliseconds 250
    }
}


$script:InteractiveTypes = @(
    'Button','CheckBox','ComboBox','Edit','Hyperlink','ListItem','MenuItem',
    'RadioButton','Tab','TabItem','Tree','TreeItem','DataItem','Document',
    'Slider','Spinner','ProgressBar','SplitButton','Menu','MenuBar','ToolBar'
)

function Invoke-ScreenOcr {
    param([string]$Path, [string]$Lang)
    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
    function Await($op, $t) {
        $x = $asTaskGeneric.MakeGenericMethod($t).Invoke($null, @($op))
        if (-not $x.Wait(25000)) { throw "WinRT-вызов не завершился за 25 с" }
        return $x.Result
    }
    $T = @{
        StorageFile  = [Windows.Storage.StorageFile, Windows, ContentType = WindowsRuntime]
        FileAccess   = [Windows.Storage.FileAccessMode, Windows, ContentType = WindowsRuntime]
        Decoder      = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
        SoftBitmap   = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
        OcrEngine    = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
        OcrResult    = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
        Language     = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]
        RandomStream = [Windows.Storage.Streams.IRandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime]
    }
    $sf  = Await ($T.StorageFile::GetFileFromPathAsync($Path)) $T.StorageFile
    $ras = Await ($sf.OpenAsync($T.FileAccess::Read)) $T.RandomStream
    $dec = Await ($T.Decoder::CreateAsync($ras)) $T.Decoder
    $sb  = Await ($dec.GetSoftwareBitmapAsync()) $T.SoftBitmap
    $eng = $null
    if ($Lang) { $eng = $T.OcrEngine::TryCreateFromLanguage($T.Language::new($Lang)) }
    if (-not $eng) { $eng = $T.OcrEngine::TryCreateFromUserProfileLanguages() }
    if (-not $eng) { throw "Не удалось создать OCR-движок: нет ни языка $Lang, ни языков профиля" }
    $res = Await ($eng.RecognizeAsync($sb)) $T.OcrResult
    $lines = @()
    # WinRT-коллекции (IReadOnlyList) приводим к массиву явно: PowerShell
    # разворачивает их при обращении к .Count, и количество получается
    # перечислением значений вместо числа.
    foreach ($l in @($res.Lines)) {
        $wordArr = @($l.Words)
        if ($wordArr.Count -eq 0) { continue }
        $words = @()
        foreach ($w in $wordArr) {
            $b = $w.BoundingRect
            $words += [ordered]@{
                text = $w.Text
                rect = [ordered]@{ x = [int]$b.X; y = [int]$b.Y; w = [int]$b.Width; h = [int]$b.Height }
            }
        }
        $b0 = $wordArr[0].BoundingRect
        $bN = $wordArr[$wordArr.Count - 1].BoundingRect
        $lines += [ordered]@{
            text = $l.Text
            rect = [ordered]@{
                x = [int]$b0.X
                y = [int]$b0.Y
                w = [int](($bN.X + $bN.Width) - $b0.X)
                h = [int](($bN.Y + $bN.Height) - $b0.Y)
            }
            words = $words
        }
    }
    return [ordered]@{
        text = $res.Text
        lineCount = $lines.Count
        lines = $lines
        image = [ordered]@{ x = 0; y = 0; w = $sb.PixelWidth; h = $sb.PixelHeight }
    }
}

$script:UiCache = @{}

# Обход дерева UIA стоит сотни миллисекунд, а агентный цикл обычно делает
# find → invoke → verify на одном и том же окне. Короткий кэш (1.2 с) убирает
# повторный обход, но недостаточно мал, чтобы отдать протухшие данные после
# перерисовки интерфейса.
function Get-UiCached([string]$key, [scriptblock]$make) {
    $now = [Environment]::TickCount64
    if ($script:UiCache.ContainsKey($key)) {
        $e = $script:UiCache[$key]
        if (($now - $e.at) -lt 1200) { return $e.data }
    }
    $d = & $make
    $script:UiCache[$key] = @{ at = $now; data = $d }
    if ($script:UiCache.Count -gt 64) { $script:UiCache.Clear() }
    return , $d
}

function Get-ElementInfosCached {
    param([string]$Title, [string]$Name, [string]$Type, [string]$Id, [int]$MaxDepth, [int]$Limit)
    $key = "ei|$Title|$Name|$Type|$Id|$MaxDepth|$Limit"
    return Get-UiCached $key {
        $hits = Search-UiElements $Title $Name $Type $Id $MaxDepth $Limit
        $items = @()
        foreach ($h in $hits) { $items += ,(Convert-ElementInfo $h) }
        , $items
    }
}

function Get-UiNodes($el, [int]$depth, [int]$maxDepth, [ref]$counter, [int]$maxElements, [bool]$interactiveOnly) {
    if ($depth -gt $maxDepth) { return @() }
    if ($counter.Value -ge $maxElements) { return @() }

    $c = $null
    try { $c = $el.Current } catch { return @() }
    $ct = $c.ControlType.ProgrammaticName -replace '^ControlType\.', ''
    $counter.Value++
    $rawName = ''
    try { $rawName = [string]$c.Name } catch { }

    $include = (-not $interactiveOnly) -or ($depth -eq 0) -or ($script:InteractiveTypes -contains $ct)

    $children = @()
    if ($depth -lt $maxDepth) {
        try {
            $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
            $child = $walker.GetFirstChild($el)
            while ($child -ne $null -and $counter.Value -lt $maxElements) {
                $res = Get-UiNodes $child ($depth + 1) $maxDepth $counter $maxElements $interactiveOnly
                if ($null -ne $res) { $children += $res }
                try { $child = $walker.GetNextSibling($child) } catch { break }
            }
        } catch { }
    }

    if (-not $include) { return $children }

    $node = [ordered]@{
        name      = Trunc $rawName
        fullLen   = $rawName.Length
        type      = $ct
        id        = $c.AutomationId
        enabled   = $c.IsEnabled
        offscreen = $c.IsOffscreen
        rect      = Rect $c.BoundingRectangle
    }

    try {
        $pats = @()
        foreach ($p in $el.GetSupportedPatterns()) { $pats += ($p.ProgrammaticName -replace 'PatternIdentifiers\.', '') }
        if ($pats.Count -gt 0) { $node['patterns'] = $pats }
    } catch { }
    if ($node['patterns'] -and ($node['patterns'] -contains 'ValuePattern')) {
        try {
            $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            $node['value'] = Trunc $vp.Current.Value 300
        } catch { }
    }
    if ($node['patterns'] -and ($node['patterns'] -contains 'TogglePattern')) {
        try {
            $tp = $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
            $node['toggle'] = "$($tp.Current.ToggleState)"
        } catch { }
    }
    if ($node['patterns'] -and ($node['patterns'] -contains 'SelectionItemPattern')) {
        try {
            $sp = $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
            $node['selected'] = [bool]$sp.Current.IsSelected
        } catch { }
    }
    if ($node['patterns'] -and ($node['patterns'] -contains 'TextPattern')) {
        try {
            $tp = $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
            $doc = $tp.DocumentRange
            $node['text'] = Trunc $doc.GetText(-1) 300
            $node['textLen'] = $doc.Length
        } catch { }
    }
    if ($children.Count -gt 0) { $node['children'] = $children }
    return , $node
}

function Search-UiElements {
    param(
        [string]$TitleLike, [string]$NameLike, [string]$TypeName,
        [string]$AutomationId, [int]$MaxDepth, [int]$Limit
    )
    $hits = @()
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Window)
    foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {
        try {
            if (-not [DeskMcp]::IsWindowVisible([IntPtr]$w.Current.NativeWindowHandle)) { continue }
            if ($TitleLike -ne '' -and $w.Current.Name -notlike "*$(Escape-Like $TitleLike)*") { continue }
        } catch { continue }
        $counter = 0
        $stack = New-Object System.Collections.Stack
        $stack.Push(@($w, 0))
        while ($stack.Count -gt 0 -and $hits.Count -lt $Limit) {
            $top = $stack.Pop()
            $el = $top[0]; $depth = $top[1]
            if ($depth -gt $MaxDepth) { continue }
            $counter++
            if ($counter -gt 4000) { break }
            try {
                $c = $el.Current
                $ct = $c.ControlType.ProgrammaticName -replace '^ControlType\.', ''
                $okName = ($NameLike -eq '') -or ($c.Name -like "*$(Escape-Like $NameLike)*")
                $okType = ($TypeName -eq '') -or ($ct -eq $TypeName) -or ($ct -like "*$(Escape-Like $TypeName)*")
                $okId = ($AutomationId -eq '') -or ($c.AutomationId -eq $AutomationId)
                if ($okName -and $okType -and $okId) { $hits += ,@($el, $ct) }
                $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
                $ch = $walker.GetFirstChild($el)
                while ($ch -ne $null) {
                    $stack.Push(@($ch, $depth + 1))
                    $ch = $walker.GetNextSibling($ch)
                }
            } catch { }
        }
    }
    return , $hits
}

# Кэшировать COM-объекты AutomationElement нельзя: протухшая ссылка даст
# исключение при Invoke()/GetCurrentPattern() там, где раньше был успех.
# Поэтому кэшируются только НЕИЗМЕНЯЕМЫЕ идентификаторы (automationId, имя,
# роль, прямоугольник), а перед действием делается свежий поиск по этим ключам
# с проверкой, что найденный элемент всё ещё им соответствует.
# Схема предложена ревьюером и безопаснее, чем кэш объектов.
function Resolve-Target($a) {
    $title = [string]$a.title
    $name = [string]$a.name
    $type = [string]$a.type
    $id = [string]$a.id
    $depth = if ($a.maxDepth) { [int]$a.maxDepth } else { 8 }
    $el = $a.element
    if ($el) {
        if (-not $name -and $el['name']) { $name = [string]$el['name'] }
        if (-not $type -and $el['type']) { $type = [string]$el['type'] }
        if (-not $id   -and $el['id'])   { $id   = [string]$el['id'] }
    }
    $hits = Search-UiElements $title $name $type $id $depth 1
    if (@($hits).Count -eq 0 -and $el -and $el['rect']) {
        # Имя могло смениться (счётчик, «2 элемента выбрано»). Пробуем по роли
        # и по координате внутри кэшированного прямоугольника.
        $hits = Search-UiElements $title '' $type '' $depth 200
        $cx = [int]$el['rect']['x'] + [int]([int]$el['rect']['w'] / 2)
        $cy = [int]$el['rect']['y'] + [int]([int]$el['rect']['h'] / 2)
        $filtered = @()
        foreach ($h in $hits) {
            $r = (Convert-ElementInfo $h)['rect']
            if ([int]$r['x'] -le $cx -and $cx -le ([int]$r['x'] + [int]$r['w']) -and
                [int]$r['y'] -le $cy -and $cy -le ([int]$r['y'] + [int]$r['h'])) { $filtered += ,$h }
        }
        $hits = $filtered
    }
    return , $hits
}

function Convert-ElementInfo($pair) {
    $el = $pair[0]; $ct = $pair[1]
    $c = $el.Current
    $pats = @()
    try { foreach ($p in $el.GetSupportedPatterns()) { $pats += ($p.ProgrammaticName -replace 'PatternIdentifiers\.', '') } } catch { }
    $info = [ordered]@{
        name  = (Trunc $c.Name 160)
        type  = $ct
        id    = $c.AutomationId
        class = $c.ClassName
        rect  = Rect $c.BoundingRectangle
        enabled   = $c.IsEnabled
        offscreen = $c.IsOffscreen
        patterns  = $pats
    }
    if ($pats -contains 'ValuePattern') {
        try { $info['value'] = Trunc $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value 300 } catch { }
    }
    if ($pats -contains 'TogglePattern') {
        try { $info['toggle'] = "$($el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState)" } catch { }
    }
    if ($pats -contains 'SelectionItemPattern') {
        try { $info['selected'] = [bool]$el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Current.IsSelected } catch { }
    }
    if ($pats -contains 'TextPattern') {
        try {
            $doc = $el.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern).DocumentRange
            $info['text'] = Trunc $doc.GetText(-1) 300
            $info['textLen'] = $doc.Length
        } catch { }
    }
    return , $info
}

function Has-Prop($obj, [string]$name) {
    if ($null -eq $obj) { return $false }
    return ($null -ne $obj.PSObject.Properties[$name])
}

function Count-NamedUi($nodes) {
    $n = 0
    foreach ($x in $nodes) {
        if ($null -eq $x) { continue }
        $name = $x['name']
        if ($name -and "$name".Trim() -ne '') { $n++ }
        $kids = $x['children']
        if ($kids) { $n += (Count-NamedUi $kids) }
    }
    return $n
}

function Count-NamedUiInside($windows) {
    $n = 0
    foreach ($w in $windows) {
        if ($null -eq $w) { continue }
        $kids = $w['children']
        if ($kids) { $n += (Count-NamedUi $kids) }
    }
    return $n
}

function Get-UiTree([string]$titleLike, [int]$maxDepth, [int]$maxElements, [bool]$interactiveOnly) {    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $cond = New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        [System.Windows.Automation.ControlType]::Window)
    $targets = @()
    foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {
        try {
            if ([DeskMcp]::IsWindowVisible([IntPtr]$w.Current.NativeWindowHandle) -and
                ($titleLike -eq '' -or $w.Current.Name -like "*$(Escape-Like $titleLike)*")) {
                $targets += $w
            }
        } catch { }
    }
    $counter = 0
    $trees = @()
    foreach ($t in $targets) {
        $counter = 0
        $n = Get-UiNodes $t 0 $maxDepth ([ref]$counter) $maxElements $interactiveOnly
        if ($null -ne $n) { $trees += $n }
    }
    return [ordered]@{ windows = $trees; elementsScanned = $counter }
}

function Get-ElementAt([int]$x, [int]$y) {
    $p = New-Object System.Windows.Point($x, $y)
    $el = [System.Windows.Automation.AutomationElement]::FromPoint($p)
    if ($el -eq $null) { return [ordered]@{ found = $false } }
    $chain = @()
    $cur = $el
    for ($i = 0; $i -lt 6 -and $cur -ne $null; $i++) {
        try {
            $c = $cur.Current
            $chain += [ordered]@{
                name = (Trunc $c.Name 120); type = ($c.ControlType.ProgrammaticName -replace '^ControlType\.','')
                id = $c.AutomationId; class = $c.ClassName; rect = Rect $c.BoundingRectangle
            }
            $cur = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($cur)
        } catch { break }
    }
    return [ordered]@{ found = $true; x = $x; y = $y; chain = $chain }
}


function Save-Screenshot {
    param([string]$Region, [int]$Display, [double]$Scale, [string]$Format, [int]$Quality, [string]$WindowTitle)
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $x = $vs.Left; $y = $vs.Top; $w = $vs.Width; $h = $vs.Height
    if ($Region) {
        $p = $Region -split ','
        if ($p.Count -ne 4) { throw "Region должен быть 'x,y,w,h', получено '$Region'" }
        $x = [int]$p[0]; $y = [int]$p[1]; $w = [int]$p[2]; $h = [int]$p[3]
    }
    if ($w -le 0 -or $h -le 0) { throw "Пустой размер снимка: ${w}x${h}" }

    $bmp = $null; $g = $null; $g2 = $null; $out = $null; $ms = $null; $ep = $null
    $via = 'screen'
    try {
        if ($WindowTitle) {
            $win = Find-WindowByTitle $WindowTitle 3
            if (-not $win) { throw "Окно '*$WindowTitle*' не найдено за 3 с" }
            $proc = Get-Process -Id $win.process
            $bmp = [DeskMcp]::CaptureWindow($proc.MainWindowHandle)
            if ($null -eq $bmp) { throw "PrintWindow вернул пустой кадр для '$($win.title)'" }
            $bounds = [DeskMcp]::WindowBounds($proc.MainWindowHandle)
            $x = $bounds.X; $y = $bounds.Y
            $w = $bmp.Width; $h = $bmp.Height
            $via = 'printwindow'
        } else {
            $bmp = New-Object System.Drawing.Bitmap $w, $h
            $g = [System.Drawing.Graphics]::FromImage($bmp)
            $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size $w, $h))
            $g.Dispose(); $g = $null
        }

        $tw = $w; $th = $h
        if ($Scale -gt 0 -and $w -gt 1 -and ($Scale -lt 1 -or $Scale -gt 1)) {
            $tw = [Math]::Max(1, [int]($w * $Scale)); $th = [Math]::Max(1, [int]($h * $Scale))
        }
        $out = $bmp
        if ($tw -ne $w -or $th -ne $h) {
            $out = New-Object System.Drawing.Bitmap $tw, $th
            $g2 = [System.Drawing.Graphics]::FromImage($out)
            $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $g2.DrawImage($bmp, 0, 0, $tw, $th)
            $g2.Dispose(); $g2 = $null
        }

        $ms = New-Object System.IO.MemoryStream
        if ($Format -eq 'jpeg') {
            $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
                     Where-Object { $_.MimeType -eq 'image/jpeg' }
            $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
            $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter(
                [System.Drawing.Imaging.Encoder]::Quality, $Quality)
            $out.Save($ms, $codec, $ep)
            $mime = 'image/jpeg'
        } else {
            $out.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
            $mime = 'image/png'
        }
        $bytes = $ms.ToArray()

        return [ordered]@{
            mime = $mime
            width = $tw
            height = $th
            via = $via
            region = [ordered]@{ x = $x; y = $y; w = $w; h = $h }
            bytes = [Convert]::ToBase64String($bytes)
        }
    } finally {
        if ($ep)    { $ep.Dispose() }
        if ($ms)    { $ms.Dispose() }
        if ($g2)    { $g2.Dispose() }
        if ($out)   { $out.Dispose() }
        if ($bmp -and $bmp -ne $out) { $bmp.Dispose() }
        if ($g)     { $g.Dispose() }
    }
}


function Test-Permissions {
    $issues = @()
    $fw = [DeskMcp]::GetForegroundWindow()
    $fgPid = 0
    if ($fw -ne [IntPtr]::Zero) {
        $fgPid = (Get-Process | Where-Object { $_.MainWindowHandle -eq $fw } | Select-Object -First 1).Id
    }
    $integrity = 'unknown'
    try {
        $self = Get-Process -Id $PID
        $integrity = 'medium-or-higher'
    } catch { }
    if ($integrity -eq 'unknown') { $issues += 'Не удалось определить уровень целостности процесса.' }

    $hasUia = $true
    try { [System.Windows.Automation.AutomationElement]::RootElement | Out-Null }
    catch { $hasUia = $false; $issues += 'UI Automation недоступна — дерево UI и element_at работать не будут.' }

    $clip = $true
    try { Get-Clipboard -ErrorAction Stop | Out-Null } catch { $clip = $false }

    return [ordered]@{
        ok = ($issues.Count -eq 0)
        uia = $hasUia
        clipboard = $clip
        foreground = (Get-WindowList | Where-Object { $_.visible } | Select-Object -First 3)
        note = 'Инъекция ввода блокируется в окна, запущенные с повышенными правами (UIPI). Это ограничение Windows, а не ошибка.'
    }
}


function Invoke-Tool {
    param([string]$tool, $a)
    $result = $null
    switch ($tool) {
            'screenshot' {
                $fmt = if ($a.format) { $a.format } else { 'png' }
                $result = Save-Screenshot -Region $a.region -Display $a.display `
                                        -Scale $(if ($a.scale) { [double]$a.scale } else { 0 }) `
                                        -Format $fmt -Quality $(if ($a.quality) { [int]$a.quality } else { 80 }) `
                                        -WindowTitle ([string]$a.window)
            }

            'bench' {
                $action = [string]$a.action
                switch ($action) {
                    'show'  { $result = [ordered]@{ ok = $true; pid = Start-Bench } }
                    'read'  { $result = [ordered]@{ ok = $true; log = Read-BenchLog } }
                    'close' { Stop-Bench; $result = [ordered]@{ ok = $true } }
                    default { throw "Неизвестное действие bench: '$action' (show|read|close)" }
                }
            }

            'desktop' {
                $action = [string]$a.action
                switch ($action) {
                    'list' { $result = Get-DeskInfo }
                    'create' {
                        $id = [VDesk]::Create()
                        if ($a.switchTo) { [VDesk]::Switch($id) }
                        $result = [ordered]@{ ok = $true; id = $id; switched = [bool]$a.switchTo }
                    }
                    'switch' { [VDesk]::Switch([string]$a.id); $result = [ordered]@{ ok = $true; id = [string]$a.id } }
                    'close' { [VDesk]::Close([string]$a.id); $result = [ordered]@{ ok = $true; id = [string]$a.id } }
                    'of_window' {
                        $w = Find-WindowByTitle ([string]$a.title) 3
                        if (-not $w) { throw "Окно '*$($a.title)*' не найдено" }
                        $proc = Get-Process -Id $w.process
                        $result = [ordered]@{ title = $w.title; desktop = [VDesk]::OfWindow($proc.MainWindowHandle) }
                    }
                    'move_window' {
                        $w = Find-WindowByTitle ([string]$a.title) 3
                        if (-not $w) { throw "Окно '*$($a.title)*' не найдено" }
                        $proc = Get-Process -Id $w.process
                        [VDesk]::MoveWindowTo($proc.MainWindowHandle, [string]$a.id)
                        $result = [ordered]@{ ok = $true; title = $w.title; desktop = [string]$a.id }
                    }
                    default { throw "Неизвестное действие desktop: '$action' (list|create|switch|close|of_window|move_window)" }
                }
            }

            'batch' {
                $steps = @($a.steps)
                if ($steps.Count -eq 0) { throw "steps пуст" }
                if ($steps.Count -gt 50) { throw "Слишком много шагов за раз: $($steps.Count), максимум 50" }
                $known = @('active_window', 'bench', 'click', 'clipboard_get', 'clipboard_set', 'close_window', 'cursor', 'desktop', 'drag', 'element_at', 'find', 'focus', 'invoke', 'key', 'key_down', 'key_up', 'launch', 'mouse_button', 'move', 'ocr', 'permissions', 'read_screen', 'screeninfo', 'screenshot', 'scroll', 'select_text', 'set_frame', 'set_value', 'type', 'verify', 'wait', 'wait_window', 'windows')
                $rename = @{ 'computer_window_set_frame' = 'set_frame'; 'computer_verify_state' = 'verify' }
                $out = @()
                $stoppedAt = $null
                for ($i = 0; $i -lt $steps.Count; $i++) {
                    $s = $steps[$i]
                    $given = [string]$s.tool
                    $stepTool = $given
                    if ($rename.ContainsKey($stepTool)) { $stepTool = $rename[$stepTool] }
                    elseif ($stepTool.StartsWith('computer_')) { $stepTool = $stepTool.Substring(9) }
                    $stepArgs = $s.args
                    if (-not $stepArgs) { $stepArgs = @{} }
                    if ($known -notcontains $stepTool) {
                        $out += [ordered]@{ index = $i; tool = $given; ok = $false; error = "Неизвестный инструмент: '$given'. В batch ждут: $($known -join ', ')" }
                        if ($s.stopOnError -eq $false) { continue }
                        $stoppedAt = $i
                        break
                    }
                    try {
                        $res = Invoke-Tool $stepTool $stepArgs
                        $out += [ordered]@{ index = $i; tool = $given; ok = $true; data = $res }
                    } catch {
                        $out += [ordered]@{ index = $i; tool = $given; ok = $false; error = $_.Exception.Message }
                        if ($s.stopOnError -eq $false) { continue }
                        $stoppedAt = $i
                        break
                    }
                }
                $result = [ordered]@{
                    executed = $out.Count
                    stoppedAt = $stoppedAt
                    allOk = (@($out | Where-Object { -not $_.ok }).Count -eq 0)
                    steps = $out
                }
            }

            'screeninfo' {
                $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
                $monitors = [System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
                    [ordered]@{
                        device = $_.DeviceName
                        primary = $_.Primary
                        x = $_.Bounds.X; y = $_.Bounds.Y
                        w = $_.Bounds.Width; h = $_.Bounds.Height
                    }
                }
                $result = [ordered]@{
                    virtual = [ordered]@{ x = $vs.Left; y = $vs.Top; w = $vs.Width; h = $vs.Height }
                    monitors = @($monitors)
                }
            }

            'permissions' { $result = Test-Permissions }

            'click' {
                $mods = @()
                if ($a.modifiers) {
                    foreach ($m in $a.modifiers) {
                        $mv = Get-Vk $m
                        if ($null -eq $mv) { throw "Неизвестный модификатор: '$m'" }
                        $mods += $mv
                    }
                }
                if ($a.hoverFirst) { [DeskMcp]::MoveTo([int]$a.x, [int]$a.y); Start-Sleep -Milliseconds 250 }
                elseif ($mods.Count -gt 0) { [DeskMcp]::MoveTo([int]$a.x, [int]$a.y); Start-Sleep -Milliseconds 60 }
                $wasDown = @()
                foreach ($m in $mods) {
                    $wasDown += [DeskMcp]::KeyDown([uint16]$m)
                    [DeskMcp]::VKey([uint16]$m, $false)
                }
                Start-Sleep -Milliseconds 30
                [DeskMcp]::Click($(if ($a.button) { $a.button } else { 'left' }), $(if ($a.count) { [int]$a.count } else { 1 }))
                Start-Sleep -Milliseconds 30
                for ($i = $mods.Count - 1; $i -ge 0; $i--) {
                    if (-not $wasDown[$i]) { [DeskMcp]::VKey([uint16]$mods[$i], $true) }
                }
                $result = [ordered]@{
                    ok = $true; x = [int]$a.x; y = [int]$a.y
                    button = $(if ($a.button) { $a.button } else { 'left' })
                    count = $(if ($a.count) { [int]$a.count } else { 1 })
                    modifiers = $a.modifiers
                }
            }

            'key_down' {
                $vk = Get-Vk ([string]$a.key)
                if ($null -eq $vk) { throw "Неизвестная клавиша: '$($a.key)'" }
                $n = [DeskMcp]::VKey([uint16]$vk, $false)
                if ($n -ne 1) { throw "SendInput не принял нажатие '$($a.key)' (UIPI?)" }
                $result = [ordered]@{ ok = $true; key = $a.key; down = $true; note = 'Клавиша осталась зажатой — отпусти через computer_key_up' }
            }

            'key_up' {
                $vk = Get-Vk ([string]$a.key)
                if ($null -eq $vk) { throw "Неизвестная клавиша: '$($a.key)'" }
                $n = [DeskMcp]::VKey([uint16]$vk, $true)
                if ($n -ne 1) { throw "SendInput не принял отпускание '$($a.key)' (UIPI?)" }
                $result = [ordered]@{ ok = $true; key = $a.key; up = $true }
            }

            'wait' {
                $ms = if ($a.ms -ne $null) { [int]$a.ms } else { 1000 }
                if ($ms -lt 0 -or $ms -gt 120000) { throw "Пауза вне диапазона 0..120000 мс: $ms" }
                Start-Sleep -Milliseconds $ms
                $result = [ordered]@{ ok = $true; waitedMs = $ms }
            }

            'mouse_button' {
                $btn = if ($a.button) { $a.button } else { 'left' }
                if ($a.down) { [DeskMcp]::ButtonDown($btn) } else { [DeskMcp]::ButtonUp($btn) }
                $result = [ordered]@{ ok = $true; button = $btn; pressed = [bool]$a.down }
            }

            'cursor' {
                $pt = New-Object DeskMcp+POINT
                $ok = [DeskMcp]::GetCursorPos([ref]$pt)
                if (-not $ok) { throw "GetCursorPos вернул false" }
                $result = [ordered]@{ ok = $true; x = $pt.X; y = $pt.Y }
            }

            'move' {
                [DeskMcp]::MoveTo([int]$a.x, [int]$a.y)
                $result = [ordered]@{ ok = $true; x = [int]$a.x; y = [int]$a.y }
            }

            'drag' {
                $steps = if ($a.steps) { [int]$a.steps } else { 25 }
                $stepMs = if ($a.stepMs) { [int]$a.stepMs } else { 12 }
                [DeskMcp]::Drag([int]$a.fromX, [int]$a.fromY, [int]$a.toX, [int]$a.toY, $steps, $stepMs)
                $result = [ordered]@{ ok = $true }
            }

            'scroll' {
                if ($a.x -ne $null -and $a.y -ne $null) { [DeskMcp]::MoveTo([int]$a.x, [int]$a.y); Start-Sleep -Milliseconds 60 }
                [DeskMcp]::ScrollWheel([int]$(if ($a.dx) { $a.dx } else { 0 }), [int]$(if ($a.dy) { $a.dy } else { 0 }))
                $result = [ordered]@{ ok = $true }
            }

            'type' {
                $txt = [string]$a.text
                $n = [DeskMcp]::TypeUnicode($txt)
                if ($txt.Length -gt 0 -and $n -ne $txt.Length * 2) {
                    throw "SendInput принял $n событий из $($txt.Length * 2) — ввод заблокирован (UIPI?)"
                }
                $result = [ordered]@{ ok = $true; chars = $txt.Length; events = $n }
            }

            'key' {
                $parts = ([string]$a.keys) -split '\+' | ForEach-Object { $_.Trim().ToLowerInvariant() } | Where-Object { $_ -ne '' }
                $mods = @(); $main = $null
                foreach ($p in $parts) {
                    if ($p -in @('ctrl','control','shift','alt','win','lwin')) { $mods += (Get-Vk $p) } else { $main = $p }
                }
                if (-not $main) { throw "Не найдена основная клавиша в '$($a.keys)'" }
                $vk = Get-Vk $main
                if ($null -eq $vk) { throw "Неизвестная клавиша: '$main'" }
                $sent = 0
                $wasDown = @()
                foreach ($m in $mods) {
                    $wasDown += [DeskMcp]::KeyDown([uint16]$m)
                    $sent += [DeskMcp]::VKey([uint16]$m, $false)
                }
                Start-Sleep -Milliseconds 30
                $sent += [DeskMcp]::VKey([uint16]$vk, $false)
                Start-Sleep -Milliseconds 30
                $sent += [DeskMcp]::VKey([uint16]$vk, $true)
                for ($i = $mods.Count - 1; $i -ge 0; $i--) {
                    if (-not $wasDown[$i]) { $sent += [DeskMcp]::VKey([uint16]$mods[$i], $true) }
                }
                if ($sent -ne (($mods.Count + 1) * 2)) {
                    throw "SendInput принял $sent событий из $(($mods.Count + 1) * 2) — ввод не дошёл"
                }
                $result = [ordered]@{ ok = $true; keys = $a.keys; events = $sent }
            }

            'windows' {
                $all = Get-WindowList
                if ($a.filter) { $pat = "*$(Escape-Like $a.filter)*"; $all = $all | Where-Object { $_.title -like $pat } }
                $result = [ordered]@{ count = @($all).Count; windows = @($all) }
            }

            'focus' {
                $w = Find-WindowByTitle ([string]$a.title) 3
                if (-not $w) { throw "Окно с заголовком '*$($a.title)*' не найдено за 3 с" }
                $p = Get-Process -Id $w.process
                $ok = [DeskMcp]::Focus($p.MainWindowHandle)
                $result = [ordered]@{ ok = $ok; title = $w.title; process = $w.process }
            }

            'wait_window' {
                $t = if ($a.timeoutSec) { [int]$a.timeoutSec } else { 20 }
                $sw = [System.Diagnostics.Stopwatch]::StartNew()
                $w = Find-WindowByTitle ([string]$a.title) $t
                if (-not $w) { throw "Окно '*$($a.title)*' не появилось за $t с" }
                $result = [ordered]@{ ok = $true; title = $w.title; waitedMs = $sw.ElapsedMilliseconds }
            }

            'close_window' {
                # Разрушительное действие: закрывает чужое окно, а с force ещё и
                # убивает процесс с несохранёнными данными. Требуем явного
                # подтверждения — ровно как needsApproval у OpenAI.
                if (-not $a.confirm) {
                    throw "Закрытие окна требует подтверждения: повтори с confirm: true (окно '*$($a.title)*'$(if ($a.force) { ', force: ' + $a.force }))"
                }
                $w = Find-WindowByTitle ([string]$a.title) 3
                if (-not $w) { throw "Окно '*$($a.title)*' не найдено" }
                $p = Get-Process -Id $w.process -ErrorAction SilentlyContinue
                if ($a.force) { $p.Kill() } else { $p.CloseMainWindow() | Out-Null }
                $result = [ordered]@{ ok = $true; title = $w.title; forced = [bool]$a.force }
            }

            'launch' {
                if (-not $a.confirm) {
                    throw "Запуск программы требует подтверждения: повтори с confirm: true (путь '$($a.path)')"
                }
                if (-not $a.path) { throw "Не указан путь к программе" }
                $sp = @{
                    FilePath  = $a.path
                    PassThru  = $true
                    WindowStyle = if ($a.hidden) { 'Hidden' } else { 'Normal' }
                }
                if ($a.args -and @($a.args).Count -gt 0) { $sp['ArgumentList'] = @($a.args) }
                $p = Start-Process @sp
                $result = [ordered]@{ ok = $true; pid = $p.Id }
            }

            'read_screen' {
                $md = if ($a.maxDepth) { [int]$a.maxDepth } else { 6 }
                $me = if ($a.maxElements) { [int]$a.maxElements } else { 300 }
                $io = [bool]$a.interactiveOnly
                $backend = if ($a.backend) { [string]$a.backend } else { 'auto' }
                $title = [string]$a.title

                if ($backend -eq 'msaa') {
                    $t = Get-MsaaTree $title $md $me $io
                    $depth = $md
                    while ($script:MsaaUseful -lt 3 -and $depth -lt 30) {
                        $depth = $depth * 2
                        $t = Get-MsaaTree $title $depth $me $io
                    }
                    $result = [ordered]@{ backend = 'msaa'; depthUsed = $depth; useful = $script:MsaaUseful; windows = $t }
                    break
                }

                $uia = Get-UiTree $title $md $me $io
                if ($backend -eq 'uia' -or (Count-NamedUiInside $uia.windows) -ge 5) {
                    $uia['backend'] = 'uia'
                    $result = $uia
                    break
                }
                $msaa = Get-MsaaTree $title $md $me $io
                $depth = $md
                while ($script:MsaaUseful -lt 3 -and $depth -lt 30) {
                    $depth = $depth * 2
                    $msaa = Get-MsaaTree $title $depth $me $io
                }
                if (@($msaa).Count -gt 0 -and $script:MsaaUseful -gt 0) {
                    $result = [ordered]@{
                        backend = 'msaa'
                        depthUsed = $depth
                        useful = $script:MsaaUseful
                        note = 'UIA вернула пустое дерево, взят MSAA (Chromium без --force-renderer-accessibility)'
                        windows = $msaa
                    }
                } else {
                    $uia['backend'] = 'uia'
                    $result = $uia
                }
            }

            'element_at' { $result = Get-ElementAt ([int]$a.x) ([int]$a.y) }

            'clipboard_get' {
                $t = ''
                try { $t = Get-Clipboard -Raw -ErrorAction Stop } catch { $t = '' }
                if ($null -eq $t) { $t = '' }
                $result = [ordered]@{ text = $t; length = $t.Length }
            }

            'clipboard_set' {
                Set-Clipboard -Value ([string]$a.text)
                $result = [ordered]@{ ok = $true; length = ([string]$a.text).Length }
            }

            'ocr' {
                $region = if ($a.region) { [string]$a.region } else { '0,0,2560,1440' }
                $rp = $region -split ','
                if ($rp.Count -ne 4) { throw "Region должен быть 'x,y,w,h', получено '$region'" }
                $tmp = [System.IO.Path]::GetTempFileName() + '.png'
                $bmp = $null; $g = $null
                try {
                    $w = [int]$rp[2]; $h = [int]$rp[3]
                    if ($w -le 0 -or $h -le 0) { throw "Пустой размер области: ${w}x${h}" }
                    $bmp = New-Object System.Drawing.Bitmap $w, $h
                    $g = [System.Drawing.Graphics]::FromImage($bmp)
                    $g.CopyFromScreen([int]$rp[0], [int]$rp[1], 0, 0, (New-Object System.Drawing.Size $w, $h))
                    $g.Dispose(); $g = $null
                    $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
                } finally {
                    if ($g) { $g.Dispose() }
                    if ($bmp) { $bmp.Dispose() }
                }
                try {
                    $r = Invoke-ScreenOcr -Path $tmp -Lang ([string]$a.lang)
                } finally {
                    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
                }
                $r['origin'] = [ordered]@{ x = [int]$rp[0]; y = [int]$rp[1] }
                $result = $r
            }

            'find' {
                $key = "find|$([string]$a.title)|$([string]$a.name)|$([string]$a.type)|$([string]$a.id)|$([string]$a.maxDepth)|$([string]$a.limit)"
                $result = Get-UiCached $key {
                    $hits = Search-UiElements ([string]$a.title) ([string]$a.name) ([string]$a.type) `
                                           ([string]$a.id) $(if ($a.maxDepth) { [int]$a.maxDepth } else { 8 }) `
                                           $(if ($a.limit) { [int]$a.limit } else { 20 })
                    if (@($hits).Count -eq 0) { throw "Не найдено ни одного элемента по заданным условиям" }
                    $items = @()
                    foreach ($h in $hits) { $items += ,(Convert-ElementInfo $h) }
                    [ordered]@{ count = $items.Count; elements = $items }
                }
            }

            'invoke' {
                $hits = Resolve-Target $a
                if (@($hits).Count -eq 0) { throw "Элемент '$($a.name)' не найден — нажимать нечего" }
                $pair = @($hits)[0]
                $el = $pair[0]
                $info = Convert-ElementInfo $pair
                try {
                    $ip = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
                    $ip.Invoke()
                    $result = [ordered]@{ ok = $true; via = 'InvokePattern'; element = $info }
                    break
                } catch { }
                $r = $info['rect']
                if ($r['w'] -le 0 -or $r['h'] -le 0) { throw "У элемента нет InvokePattern и нулевые границы: $($r | ConvertTo-Json -Compress)" }
                $cx = $r['x'] + [int]($r['w'] / 2)
                $cy = $r['y'] + [int]($r['h'] / 2)
                [DeskMcp]::MoveTo($cx, $cy)
                Start-Sleep -Milliseconds 120
                [DeskMcp]::Click('left', 1)
                $result = [ordered]@{ ok = $true; via = 'pixel'; x = $cx; y = $cy; element = $info }
            }

            'set_value' {
                $hits = Resolve-Target $a
                if (@($hits).Count -eq 0) { throw "Элемент '$($a.name)' не найден" }
                $el = @($hits)[0][0]
                try {
                    $vp = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                    $vp.SetValue([string]$a.value)
                    $result = [ordered]@{ ok = $true; via = 'ValuePattern'; value = [string]$a.value }
                } catch {
                    throw "У элемента нет доступного для записи ValuePattern: $($_.Exception.Message)"
                }
            }

            'select_text' {
                $hits = Search-UiElements ([string]$a.title) ([string]$a.name) ([string]$a.type) `
                                       ([string]$a.id) $(if ($a.maxDepth) { [int]$a.maxDepth } else { 8 }) 1
                if (@($hits).Count -eq 0) { throw "Элемент '$($a.name)' не найден" }
                $info = Convert-ElementInfo @($hits)[0]
                $r = $info['rect']
                [DeskMcp]::MoveTo($r['x'] + [int]($r['w'] / 2), $r['y'] + [int]($r['h'] / 2))
                Start-Sleep -Milliseconds 150
                [DeskMcp]::Click('left', 1)
                Start-Sleep -Milliseconds 80
                $ctrlWasDown = [DeskMcp]::KeyDown(0x11)
                [DeskMcp]::VKey([uint16]0x11, $false)
                Start-Sleep -Milliseconds 20
                [DeskMcp]::VKey([uint16]0x41, $false)
                Start-Sleep -Milliseconds 20
                [DeskMcp]::VKey([uint16]0x41, $true)
                Start-Sleep -Milliseconds 20
                if (-not $ctrlWasDown) { [DeskMcp]::VKey([uint16]0x11, $true) }
                $result = [ordered]@{ ok = $true; note = 'Выделено всё содержимое поля (Ctrl+A)'; element = $info }
            }

            'verify' {
                $checks = @($a.expect)
                if ($checks.Count -eq 0) { throw "Ни одного предиката не передано" }
                $report = @()
                $allOk = $true
                foreach ($chk in $checks) {
                    $desc = $chk.label
                    $state = 'unknown'
                    $detail = ''
                    try {
                        if ((Has-Prop $chk 'window')) {
                            $state = $(if ($chk.window.exists) { 'satisfied' } else { 'unsatisfied' })
                        } else {
                            $role = if ($chk.selector) { $chk.selector.role } else { $null }
                            $lab  = if ($chk.selector) { $chk.selector.label_contains } else { $null }
                            # Кэшируем именно сведения (без COM-объектов): verify
                            # в агентном цикле вызывается после find и не
                            # требует живого элемента, а обход дерева стоит
                            # сотни миллисекунд каждый раз.
                            $infos = Get-ElementInfosCached ([string]$a.title) ([string]$lab) ([string]$role) '' 8 5
                            $n = @($infos).Count
                            if ($n -eq 0) { $state = 'unsatisfied'; $detail = 'не найден' }
                            else {
                                $info = @($infos)[0]
                                $detail = "найдено $n"
                                if ((Has-Prop $chk 'value_equals')) {
                                    $v = $info['value']
                                    if ($null -eq $v) { $state = 'unknown'; $detail += ', значение недоступно' }
                                    elseif ($v -eq $chk.value_equals) { $state = 'satisfied' }
                                    else { $state = 'unsatisfied'; $detail += ", значение='$v'" }
                                } elseif ((Has-Prop $chk 'enabled')) {
                                    $state = $(if ([bool]$info['enabled'] -eq [bool]$chk.enabled) { 'satisfied' } else { 'unsatisfied' })
                                    $detail += ", enabled=$($info['enabled'])"
                                } elseif ((Has-Prop $chk 'selected')) {
                                    if ($null -eq $info['selected']) { $state = 'unknown'; $detail += ', selected недоступно' }
                                    else { $state = $(if ([bool]$info['selected'] -eq [bool]$chk.selected) { 'satisfied' } else { 'unsatisfied' }) }
                                } else { $state = 'satisfied' }
                            }
                        }
                    } catch {
                        $state = 'unknown'; $detail = $_.Exception.Message
                    }
                    if ($state -ne 'satisfied') { $allOk = $false }
                    $report += [ordered]@{ check = $desc; state = $state; detail = $detail }
                }
                $result = [ordered]@{ ok = $allOk; checks = $report }
            }

            'set_frame' {
                $w = Find-WindowByTitle ([string]$a.title) 3
                if (-not $w) { throw "Окно '*$($a.title)*' не найдено за 3 с" }
                $p = Get-Process -Id $w.process
                $h = $p.MainWindowHandle
                $x = if ($null -ne $a.x) { [int]$a.x } else { $w.rect.x }
                $y = if ($null -ne $a.y) { [int]$a.y } else { $w.rect.y }
                $ww = if ($a.width)  { [int]$a.width }  else { $w.rect.w }
                $hh = if ($a.height) { [int]$a.height } else { $w.rect.h }
                $ok = [DeskMcp]::MoveWindow($h, $x, $y, $ww, $hh, $true)
                if (-not $ok) { throw "MoveWindow вернул false (окно '$($w.title)')" }
                Start-Sleep -Milliseconds 200
                $after = Find-WindowByTitle ([string]$a.title) 1
                $result = [ordered]@{
                    ok = $true; title = $w.title
                    requested = [ordered]@{ x = $x; y = $y; w = $ww; h = $hh }
                    actual = $(if ($after) { $after.rect } else { $null })
                }
            }

            'active_window' {
                $h = [DeskMcp]::GetForegroundWindow()
                $pid2 = [DeskMcp]::PidOf($h)
                $proc = Get-Process -Id $pid2 -ErrorAction SilentlyContinue
                $result = [ordered]@{
                    pid = $pid2
                    process = $(if ($proc) { $proc.ProcessName } else { $null })
                    title = $(if ($proc) { $proc.MainWindowTitle } else { $null })
                    handle = $h.ToInt64()
                }
            }

            'selftest' {
                $issues = @()
                $s = Save-Screenshot -Region '0,0,200,120' -Scale 0 -Format 'png' -Quality 80
                if (-not $s.bytes -or $s.bytes.Length -lt 100) { $issues += 'Снимок пустой' }
                $d1 = [DeskMcp]::VKey([uint16]0x10, $false)
                $u1 = [DeskMcp]::VKey([uint16]0x10, $true)
                $n = $d1 + $u1
                if ($n -ne 2) { $issues += "SendInput принял $n событий из 2 — ввод заблокирован (UIPI?)" }
                $uia = $true
                try { [System.Windows.Automation.AutomationElement]::RootElement | Out-Null } catch { $uia = $false }
                if (-not $uia) { $issues += 'UI Automation недоступна' }
                $wins = @(Get-WindowList)
                $result = [ordered]@{
                    ok = ($issues.Count -eq 0)
                    issues = $issues
                    screenshotBytes = $s.bytes.Length
                    windows = $wins.Count
                    sendInputOk = ($n -eq 2)
                    dpi = $DpiMode
                    pid = $PID
                }
            }

            default { throw "Неизвестный инструмент: '$tool'" }
        }
    return , $result
}
$script:In = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)

Send-Response 0 $true ([ordered]@{ ready = $true; pid = $PID; powershell = $PSVersionTable.PSVersion.ToString() }) $null

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ($line.Trim() -eq '') { continue }

    $id = 0
    try {
        $req = $line | ConvertFrom-Json
        $id = $req.id
        $tool = $req.tool
        $a = $req.args
        $result = Invoke-Tool $tool $a
        Send-Response $id $true $result $null
    } catch {
        Send-Response $id $false $null $_.Exception.Message
    }
}
