using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Text;

public sealed class UiaResult
{
    public bool Ok;
    public string Status;
    public object Data;
    public string Error;
    public int ThreadId;
    public int ElapsedMs;
    public bool Poisoned;

    public UiaResult()
    {
        Ok = false;
        Status = "error";
        Data = null;
        Error = "";
        ThreadId = 0;
        ElapsedMs = 0;
        Poisoned = false;
    }
}

public static class UiaNative
{
    private const string StatusOk = "ok";
    private const string StatusError = "error";
    private const string StatusTimeout = "timeout";

    private const long MaxCoord = 200000000L;
    private const int ScanBudget = 4000;
    private const int ChainDepth = 6;

    private static readonly object Gate = new object();
    private static Slot _slot = null;
    private static Thread _thread = null;
    private static int _seq = 0;
    private static int _threadsStarted = 0;
    private static int _poisoned = 0;
    private static int _timeouts = 0;

    private static readonly Regex WsRegex = new Regex(@"\s+", RegexOptions.Compiled);

    private static readonly HashSet<string> InteractiveTypes =
        new HashSet<string>(StringComparer.OrdinalIgnoreCase);

    static UiaNative()
    {
        string[] types = new string[] {
            "Button", "CheckBox", "ComboBox", "Edit", "Hyperlink", "ListItem", "MenuItem",
            "RadioButton", "Tab", "TabItem", "Tree", "TreeItem", "DataItem", "Document",
            "Slider", "Spinner", "ProgressBar", "SplitButton", "Menu", "MenuBar", "ToolBar"
        };
        for (int i = 0; i < types.Length; i++) InteractiveTypes.Add(types[i]);
    }

    private sealed class Slot
    {
        public Delegate Job;
        public ManualResetEventSlim Done = new ManualResetEventSlim(false);
        public bool Assigned;
        public bool Running;
        public string Status = StatusError;
        public object Value = null;
        public string Error = "";
        public int ThreadId = 0;
    }

    private sealed class Counter
    {
        public int Value;
    }

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    public static UiaResult Run(int timeoutMs, Delegate job)
    {
        UiaResult res = new UiaResult();
        Stopwatch sw = Stopwatch.StartNew();

        if (job == null)
        {
            res.Status = StatusError;
            res.Error = "job is null";
            res.ElapsedMs = (int)sw.ElapsedMilliseconds;
            return res;
        }
        if (IsScriptBlock(job))
        {
            res.Status = StatusError;
            res.Error = "PowerShell ScriptBlock delegate cannot execute on a foreign thread: " +
                        "no runspace is bound to the STA thread. Use RunTree, RunSearch, " +
                        "RunResolve, RunElementAt or RunSleep instead.";
            res.ElapsedMs = (int)sw.ElapsedMilliseconds;
            return res;
        }
        if (timeoutMs < 1) timeoutMs = 1;

        Slot slot = null;

        lock (Gate)
        {
            if (_slot == null || _thread == null || !_thread.IsAlive)
            {
                Slot seed = new Slot();
                _slot = seed;
                _thread = new Thread(delegate() { Pump(seed); });
                _thread.SetApartmentState(ApartmentState.STA);
                _thread.IsBackground = true;
                _thread.Name = "uia-sta-" + (++_seq).ToString(CultureInfo.InvariantCulture);
                _thread.Start();
                _threadsStarted++;
            }
            slot = _slot;

            if (slot.Running)
            {
                res.Status = StatusError;
                res.Error = "STA thread is busy with a previous job";
                res.ElapsedMs = (int)sw.ElapsedMilliseconds;
                return res;
            }

            slot.Job = job;
            slot.Done = new ManualResetEventSlim(false);
            slot.Assigned = true;
            Monitor.Pulse(Gate);
        }

        bool finished = slot.Done.Wait(timeoutMs);
        sw.Stop();

        res.ElapsedMs = (int)sw.ElapsedMilliseconds;
        res.ThreadId = slot.ThreadId;

        if (!finished)
        {
            lock (Gate)
            {
                if (ReferenceEquals(_slot, slot))
                {
                    _slot = null;
                    _thread = null;
                }
                _poisoned++;
                _timeouts++;
            }
            res.Status = StatusTimeout;
            res.Poisoned = true;
            res.Error = "job did not finish in " + timeoutMs.ToString(CultureInfo.InvariantCulture) +
                        " ms; STA thread abandoned and replaced on next Run";
            return res;
        }

        lock (Gate)
        {
            res.Status = slot.Status;
            res.Data = slot.Value;
            res.Error = slot.Error;
            res.Ok = string.Equals(slot.Status, StatusOk, StringComparison.Ordinal);
        }
        return res;
    }

    private static void Pump(Slot mine)
    {
        mine.ThreadId = Thread.CurrentThread.ManagedThreadId;

        while (true)
        {
            Delegate job;
            ManualResetEventSlim done;

            lock (Gate)
            {
                while (!mine.Assigned) Monitor.Wait(Gate);
                job = mine.Job;
                done = mine.Done;
                mine.Assigned = false;
                mine.Running = true;
            }

            object val = null;
            string err = null;
            string st = StatusOk;

            try
            {
                val = job.DynamicInvoke();
            }
            catch (TargetInvocationException tie)
            {
                Exception inner = tie.InnerException;
                Exception src = (inner == null) ? tie : inner;
                err = src.GetType().Name + ": " + src.Message;
                st = StatusError;
            }
            catch (Exception ex)
            {
                err = ex.GetType().Name + ": " + ex.Message;
                st = StatusError;
            }

            lock (Gate)
            {
                mine.Running = false;
                mine.Status = st;
                mine.Value = val;
                mine.Error = (err == null) ? "" : err;
            }

            done.Set();
        }
    }

    private static bool IsScriptBlock(Delegate job)
    {
        if (job == null) return false;
        object target = job.Target;
        if (target != null &&
            string.Equals(target.GetType().FullName,
                          "System.Management.Automation.ScriptBlock", StringComparison.Ordinal))
        {
            return true;
        }
        return string.Equals(job.Method.Name, "lambda_method", StringComparison.Ordinal);
    }

    public static UiaResult RunTree(int timeoutMs, string titleLike, int maxDepth,
                                    int maxElements, bool interactiveOnly)
    {
        Func<object> job = delegate
        {
            return TreeJson(titleLike, maxDepth, maxElements, interactiveOnly);
        };
        return Run(timeoutMs, job);
    }

    public static UiaResult RunSearch(int timeoutMs, string titleLike, string nameLike,
                                      string typeName, string automationId, int maxDepth, int limit)
    {
        Func<object> job = delegate
        {
            return SearchJson(titleLike, nameLike, typeName, automationId, maxDepth, limit);
        };
        return Run(timeoutMs, job);
    }

    public static UiaResult RunResolve(int timeoutMs, string titleLike, string nameLike,
                                       string typeName, string automationId, int maxDepth,
                                       int rectX, int rectY, int rectW, int rectH)
    {
        Func<object> job = delegate
        {
            return ResolveJson(titleLike, nameLike, typeName, automationId, maxDepth,
                               rectX, rectY, rectW, rectH);
        };
        return Run(timeoutMs, job);
    }

    public static UiaResult RunElementAt(int timeoutMs, int x, int y)
    {
        Func<object> job = delegate
        {
            return ElementAtJson(x, y);
        };
        return Run(timeoutMs, job);
    }

    public static UiaResult RunSleep(int timeoutMs, int sleepMs)
    {
        Func<object> job = delegate
        {
            Thread.Sleep(sleepMs);
            return "slept " + sleepMs.ToString(CultureInfo.InvariantCulture) + " ms";
        };
        return Run(timeoutMs, job);
    }

    public static UiaResult RunStats(int timeoutMs)
    {
        Func<object> job = delegate
        {
            return StatsJson();
        };
        return Run(timeoutMs, job);
    }

    public static string StatsJson()
    {
        lock (Gate)
        {
            StringBuilder b = new StringBuilder();
            b.Append("{\"threadsStarted\":").Append(Count(_threadsStarted));
            b.Append(",\"poisoned\":").Append(Count(_poisoned));
            b.Append(",\"timeouts\":").Append(Count(_timeouts));
            b.Append(",\"currentThreadId\":").Append(_thread == null ? 0 : _thread.ManagedThreadId);
            b.Append(",\"currentAlive\":").Append(_thread != null && _thread.IsAlive ? "true" : "false");
            b.Append(",\"currentApartment\":").Append(
                _thread == null ? "\"none\"" : J(_thread.GetApartmentState().ToString()));
            b.Append(",\"busy\":").Append((_slot != null && _slot.Running) ? "true" : "false");
            b.Append('}');
            return b.ToString();
        }
    }

    public static string TreeJson(string titleLike, int maxDepth, int maxElements, bool interactiveOnly)
    {
        try
        {
            List<string> trees = new List<string>();
            Counter last = new Counter();

            AutomationElement root = AutomationElement.RootElement;
            PropertyCondition cond = new PropertyCondition(
                AutomationElement.ControlTypeProperty, ControlType.Window);
            AutomationElementCollection wins = root.FindAll(TreeScope.Children, cond);

            foreach (AutomationElement w in wins)
            {
                try
                {
                    if (!IsWindowVisible(new IntPtr(w.Current.NativeWindowHandle))) continue;
                    if (!IsBlank(titleLike) && !Contains(w.Current.Name, titleLike)) continue;
                }
                catch (Exception)
                {
                    continue;
                }

                Counter c = new Counter();
                List<string> node = BuildNodes(w, 0, maxDepth, c, maxElements, interactiveOnly);
                for (int i = 0; i < node.Count; i++) trees.Add(node[i]);
                last = c;
            }

            return "{\"windows\":" + JoinArray(trees) + ",\"elementsScanned\":" + Count(last.Value) + "}";
        }
        catch (Exception ex)
        {
            return "{\"error\":" + J(ex.GetType().Name + ": " + ex.Message) +
                   ",\"windows\":[],\"elementsScanned\":0}";
        }
    }

    private static List<string> BuildNodes(AutomationElement el, int depth, int maxDepth, Counter c,
                                           int maxElements, bool interactiveOnly)
    {
        if (depth > maxDepth) return new List<string>();
        if (c.Value >= maxElements) return new List<string>();

        AutomationElement.AutomationElementInformation info;
        try
        {
            info = el.Current;
        }
        catch (Exception)
        {
            return new List<string>();
        }

        string ct = TypeShort(info.ControlType);
        c.Value++;

        string rawName = "";
        try
        {
            rawName = info.Name;
            if (rawName == null) rawName = "";
        }
        catch (Exception)
        {
            rawName = "";
        }

        bool include = !interactiveOnly || depth == 0 || InteractiveTypes.Contains(ct);

        List<string> kids = new List<string>();

        if (depth < maxDepth)
        {
            try
            {
                TreeWalker walker = Walker();
                AutomationElement child = walker.GetFirstChild(el);
                while (child != null && c.Value < maxElements)
                {
                    List<string> sub = BuildNodes(child, depth + 1, maxDepth, c,
                                                  maxElements, interactiveOnly);
                    for (int i = 0; i < sub.Count; i++) kids.Add(sub[i]);
                    try
                    {
                        child = walker.GetNextSibling(child);
                    }
                    catch (Exception)
                    {
                        break;
                    }
                }
            }
            catch (Exception)
            {
            }
        }

        if (!include) return kids;

        StringBuilder b = new StringBuilder(256);
        b.Append("{\"name\":").Append(J(Trunc(rawName, 200)));
        b.Append(",\"fullLen\":").Append(rawName.Length);
        b.Append(",\"type\":").Append(J(ct));

        string aid = null;
        try { aid = info.AutomationId; } catch (Exception) { aid = null; }
        b.Append(",\"id\":").Append(J(aid));

        bool enabled = false;
        bool offscreen = false;
        try { enabled = info.IsEnabled; } catch (Exception) { enabled = false; }
        try { offscreen = info.IsOffscreen; } catch (Exception) { offscreen = false; }
        b.Append(",\"enabled\":").Append(enabled ? "true" : "false");
        b.Append(",\"offscreen\":").Append(offscreen ? "true" : "false");
        b.Append(",\"rect\":").Append(RectJson(SafeRect(el)));

        List<string> pats = new List<string>();
        AppendPatterns(b, el, pats, false);

        if (Has(pats, "ValuePattern"))
        {
            try
            {
                ValuePattern vp = el.GetCurrentPattern(ValuePattern.Pattern) as ValuePattern;
                if (vp != null) b.Append(",\"value\":").Append(J(Trunc(vp.Current.Value, 300)));
            }
            catch (Exception)
            {
            }
        }

        if (Has(pats, "TogglePattern"))
        {
            try
            {
                TogglePattern tp = el.GetCurrentPattern(TogglePattern.Pattern) as TogglePattern;
                if (tp != null) b.Append(",\"toggle\":").Append(J(tp.Current.ToggleState.ToString()));
            }
            catch (Exception)
            {
            }
        }

        if (Has(pats, "SelectionItemPattern"))
        {
            try
            {
                SelectionItemPattern sp = el.GetCurrentPattern(SelectionItemPattern.Pattern) as SelectionItemPattern;
                if (sp != null) b.Append(",\"selected\":").Append(sp.Current.IsSelected ? "true" : "false");
            }
            catch (Exception)
            {
            }
        }

        if (Has(pats, "TextPattern"))
        {
            try
            {
                TextPattern tp = el.GetCurrentPattern(TextPattern.Pattern) as TextPattern;
                if (tp != null)
                {
                    TextPatternRange doc = tp.DocumentRange;
                    string full = doc.GetText(-1);
                    if (full == null) full = "";
                    b.Append(",\"text\":").Append(J(Trunc(full, 300)));
                    b.Append(",\"textLen\":").Append(Count(full.Length));
                }
            }
            catch (Exception)
            {
            }
        }

        if (kids.Count > 0) b.Append(",\"children\":").Append(JoinArray(kids));
        b.Append('}');
        List<string> one = new List<string>();
        one.Add(b.ToString());
        return one;
    }

    private static void AppendPatterns(StringBuilder b, AutomationElement el,
                                       List<string> names, bool always)
    {
        AutomationPattern[] pats = null;
        try
        {
            pats = el.GetSupportedPatterns();
        }
        catch (Exception)
        {
            pats = null;
        }
        if (pats == null) return;

        for (int i = 0; i < pats.Length; i++)
        {
            names.Add(PatternShort(pats[i]));
        }
        if (names.Count == 0 && !always) return;

        StringBuilder arr = new StringBuilder();
        arr.Append('[');
        for (int i = 0; i < names.Count; i++)
        {
            if (i > 0) arr.Append(',');
            arr.Append(J(names[i]));
        }
        arr.Append(']');
        b.Append(",\"patterns\":").Append(arr.ToString());
    }

    public static string SearchJson(string titleLike, string nameLike, string typeName,
                                    string automationId, int maxDepth, int limit)
    {
        try
        {
            List<object[]> hits = SearchCore(titleLike, nameLike, typeName, automationId, maxDepth, limit);
            List<string> outItems = new List<string>();
            for (int i = 0; i < hits.Count; i++)
            {
                outItems.Add(ElementInfoJson((AutomationElement)hits[i][0], (string)hits[i][1]));
            }
            return JoinArray(outItems);
        }
        catch (Exception ex)
        {
            return "{\"error\":" + J(ex.GetType().Name + ": " + ex.Message) + ",\"items\":[]}";
        }
    }

    public static string ResolveJson(string titleLike, string nameLike, string typeName,
                                     string automationId, int maxDepth,
                                     int rectX, int rectY, int rectW, int rectH)
    {
        try
        {
            List<object[]> hits = SearchCore(titleLike, nameLike, typeName, automationId, maxDepth, 1);
            if (hits.Count == 0 && rectW > 0 && rectH > 0)
            {
                List<object[]> broad = SearchCore(titleLike, "", typeName, "", maxDepth, 200);
                int cx = rectX + (rectW / 2);
                int cy = rectY + (rectH / 2);
                hits = new List<object[]>();
                for (int i = 0; i < broad.Count; i++)
                {
                    AutomationElement el = (AutomationElement)broad[i][0];
                    string rj = RectJson(SafeRect(el));
                    int hx = ParseRectKey(rj, "x");
                    int hy = ParseRectKey(rj, "y");
                    int hw = ParseRectKey(rj, "w");
                    int hh = ParseRectKey(rj, "h");
                    if (hx <= cx && cx <= hx + hw && hy <= cy && cy <= hy + hh)
                    {
                        hits.Add(broad[i]);
                    }
                }
            }

            List<string> outItems = new List<string>();
            for (int i = 0; i < hits.Count; i++)
            {
                outItems.Add(ElementInfoJson((AutomationElement)hits[i][0], (string)hits[i][1]));
            }
            return JoinArray(outItems);
        }
        catch (Exception ex)
        {
            return "{\"error\":" + J(ex.GetType().Name + ": " + ex.Message) + ",\"items\":[]}";
        }
    }

    private static int ParseRectKey(string rectJson, string key)
    {
        string needle = "\"" + key + "\":";
        int at = rectJson.IndexOf(needle, StringComparison.Ordinal);
        if (at < 0) return 0;
        at += needle.Length;
        int end = at;
        while (end < rectJson.Length && rectJson[end] != ',' && rectJson[end] != '}') end++;
        int value;
        if (int.TryParse(rectJson.Substring(at, end - at), NumberStyles.Integer,
                         CultureInfo.InvariantCulture, out value)) return value;
        return 0;
    }

    private static List<object[]> SearchCore(string titleLike, string nameLike, string typeName,
                                             string automationId, int maxDepth, int limit)
    {
        List<object[]> hits = new List<object[]>();

        AutomationElement root = AutomationElement.RootElement;
        PropertyCondition cond = new PropertyCondition(
            AutomationElement.ControlTypeProperty, ControlType.Window);
        AutomationElementCollection wins = root.FindAll(TreeScope.Children, cond);

        foreach (AutomationElement w in wins)
        {
            if (hits.Count >= limit) break;
            try
            {
                if (!IsWindowVisible(new IntPtr(w.Current.NativeWindowHandle))) continue;
                if (!IsBlank(titleLike) && !Contains(w.Current.Name, titleLike)) continue;
            }
            catch (Exception)
            {
                continue;
            }

            int scanned = 0;
            Stack<object[]> stack = new Stack<object[]>();
            stack.Push(new object[] { w, 0 });

            while (stack.Count > 0 && hits.Count < limit)
            {
                object[] top = stack.Pop();
                AutomationElement el = (AutomationElement)top[0];
                int depth = (int)top[1];

                if (depth > maxDepth) continue;
                scanned++;
                if (scanned > ScanBudget) break;

                try
                {
                    AutomationElement.AutomationElementInformation info = el.Current;
                    string ct = TypeShort(info.ControlType);

                    bool okName = IsBlank(nameLike) || Contains(info.Name, nameLike);
                    bool okType = IsBlank(typeName) ||
                                  string.Equals(ct, typeName, StringComparison.OrdinalIgnoreCase) ||
                                  Contains(ct, typeName);
                    bool okId = IsBlank(automationId) ||
                                string.Equals(info.AutomationId, automationId, StringComparison.OrdinalIgnoreCase);

                    if (okName && okType && okId) hits.Add(new object[] { el, ct });

                    TreeWalker walker = Walker();
                    AutomationElement ch = walker.GetFirstChild(el);
                    while (ch != null)
                    {
                        stack.Push(new object[] { ch, depth + 1 });
                        ch = walker.GetNextSibling(ch);
                    }
                }
                catch (Exception)
                {
                }
            }
        }

        return hits;
    }

    private static string ElementInfoJson(AutomationElement el, string ct)
    {
        AutomationElement.AutomationElementInformation info = el.Current;

        StringBuilder b = new StringBuilder(256);
        b.Append("{\"name\":").Append(J(Trunc(info.Name, 160)));
        b.Append(",\"type\":").Append(J(ct));
        b.Append(",\"id\":").Append(J(info.AutomationId));
        b.Append(",\"class\":").Append(J(info.ClassName));
        b.Append(",\"rect\":").Append(RectJson(SafeRect(el)));

        bool enabled = false;
        bool offscreen = false;
        try { enabled = info.IsEnabled; } catch (Exception) { enabled = false; }
        try { offscreen = info.IsOffscreen; } catch (Exception) { offscreen = false; }
        b.Append(",\"enabled\":").Append(enabled ? "true" : "false");
        b.Append(",\"offscreen\":").Append(offscreen ? "true" : "false");

        List<string> pats = new List<string>();
        AppendPatterns(b, el, pats, true);

        if (Has(pats, "ValuePattern"))
        {
            try
            {
                ValuePattern vp = el.GetCurrentPattern(ValuePattern.Pattern) as ValuePattern;
                if (vp != null) b.Append(",\"value\":").Append(J(Trunc(vp.Current.Value, 300)));
            }
            catch (Exception)
            {
            }
        }

        if (Has(pats, "TogglePattern"))
        {
            try
            {
                TogglePattern tp = el.GetCurrentPattern(TogglePattern.Pattern) as TogglePattern;
                if (tp != null) b.Append(",\"toggle\":").Append(J(tp.Current.ToggleState.ToString()));
            }
            catch (Exception)
            {
            }
        }

        if (Has(pats, "SelectionItemPattern"))
        {
            try
            {
                SelectionItemPattern sp = el.GetCurrentPattern(SelectionItemPattern.Pattern) as SelectionItemPattern;
                if (sp != null) b.Append(",\"selected\":").Append(sp.Current.IsSelected ? "true" : "false");
            }
            catch (Exception)
            {
            }
        }

        if (Has(pats, "TextPattern"))
        {
            try
            {
                TextPattern tp = el.GetCurrentPattern(TextPattern.Pattern) as TextPattern;
                if (tp != null)
                {
                    TextPatternRange doc = tp.DocumentRange;
                    string full = doc.GetText(-1);
                    if (full == null) full = "";
                    b.Append(",\"text\":").Append(J(Trunc(full, 300)));
                    b.Append(",\"textLen\":").Append(Count(full.Length));
                }
            }
            catch (Exception)
            {
            }
        }

        b.Append('}');
        return b.ToString();
    }

    public static string ElementAtJson(int x, int y)
    {
        try
        {
            AutomationElement el = AutomationElement.FromPoint(new Point(x, y));
            if (el == null) return "{\"found\":false}";

            List<string> chain = new List<string>();
            AutomationElement cur = el;

            for (int i = 0; i < ChainDepth && cur != null; i++)
            {
                try
                {
                    AutomationElement.AutomationElementInformation info = cur.Current;
                    StringBuilder b = new StringBuilder(160);
                    b.Append("{\"name\":").Append(J(Trunc(info.Name, 120)));
                    b.Append(",\"type\":").Append(J(TypeShort(info.ControlType)));
                    b.Append(",\"id\":").Append(J(info.AutomationId));
                    b.Append(",\"class\":").Append(J(info.ClassName));
                    b.Append(",\"rect\":").Append(RectJson(SafeRect(cur)));
                    b.Append('}');
                    chain.Add(b.ToString());
                    cur = Walker().GetParent(cur);
                }
                catch (Exception)
                {
                    break;
                }
            }

            return "{\"found\":true,\"x\":" + Count(x) + ",\"y\":" + Count(y) +
                   ",\"chain\":" + JoinArray(chain) + "}";
        }
        catch (Exception ex)
        {
            return "{\"found\":false,\"error\":" + J(ex.GetType().Name + ": " + ex.Message) + "}";
        }
    }

    private static TreeWalker Walker()
    {
        return TreeWalker.ControlViewWalker;
    }

    private static Rect SafeRect(AutomationElement el)
    {
        try
        {
            return el.Current.BoundingRectangle;
        }
        catch (Exception)
        {
            return Rect.Empty;
        }
    }

    private static string RectJson(Rect r)
    {
        StringBuilder b = new StringBuilder(72);
        b.Append("{\"x\":").Append(Coord(r.X));
        b.Append(",\"y\":").Append(Coord(r.Y));
        b.Append(",\"w\":").Append(Coord(r.Width));
        b.Append(",\"h\":").Append(Coord(r.Height));
        b.Append('}');
        return b.ToString();
    }

    private static string Coord(double d)
    {
        if (double.IsInfinity(d) || double.IsNaN(d)) d = 0.0;
        if (Math.Abs(d) > MaxCoord) d = 0.0;
        return Count((int)Math.Round(d));
    }

    private static string Count(int v)
    {
        return v.ToString(CultureInfo.InvariantCulture);
    }

    private static string Trunc(string s, int max)
    {
        if (s == null) return "";
        string t = WsRegex.Replace(s, " ");
        if (t.Length <= max) return t;
        return t.Substring(0, max) + "\u2026";
    }

    private static string TypeShort(ControlType t)
    {
        string n = t.ProgrammaticName;
        if (n == null) return "";
        const string prefix = "ControlType.";
        if (n.StartsWith(prefix, StringComparison.Ordinal)) return n.Substring(prefix.Length);
        return n;
    }

    private static string PatternShort(AutomationPattern p)
    {
        string n = p.ProgrammaticName;
        if (n == null) return "";
        return n.Replace("PatternIdentifiers.", "");
    }

    private static bool Has(List<string> pats, string name)
    {
        for (int i = 0; i < pats.Count; i++)
        {
            if (string.Equals(pats[i], name, StringComparison.OrdinalIgnoreCase)) return true;
        }
        return false;
    }

    private static bool IsBlank(string s)
    {
        return s == null || s.Length == 0;
    }

    private static bool Contains(string haystack, string needle)
    {
        if (needle == null || needle.Length == 0) return true;
        if (haystack == null) return false;
        return haystack.IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0;
    }

    private static string JoinArray(List<string> items)
    {
        if (items == null || items.Count == 0) return "[]";
        StringBuilder b = new StringBuilder();
        b.Append('[');
        for (int i = 0; i < items.Count; i++)
        {
            if (i > 0) b.Append(',');
            b.Append(items[i]);
        }
        b.Append(']');
        return b.ToString();
    }

    private static string J(string s)
    {
        if (s == null) return "null";
        StringBuilder b = new StringBuilder(s.Length + 8);
        b.Append('"');
        for (int i = 0; i < s.Length; i++)
        {
            char c = s[i];
            if (c == '"') b.Append("\\\"");
            else if (c == '\\') b.Append("\\\\");
            else if (c == '\n') b.Append("\\n");
            else if (c == '\r') b.Append("\\r");
            else if (c == '\t') b.Append("\\t");
            else if (c == '\b') b.Append("\\b");
            else if (c == '\f') b.Append("\\f");
            else if (c < ' ') b.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
            else b.Append(c);
        }
        b.Append('"');
        return b.ToString();
    }
}
