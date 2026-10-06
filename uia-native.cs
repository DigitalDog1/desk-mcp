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

    // Имена с суффиксом Compact, а не перегрузки RunTree: вызов идёт через
    // рефлексию по имени (GetMethod), и две перегрузки дают AmbiguousMatchException.
    public static UiaResult RunTreeCompact(int timeoutMs, string titleLike, int maxDepth,
                                    int maxElements, bool interactiveOnly, bool compact,
                                    int maxChars)
    {
        Func<object> job = delegate
        {
            return TreeJson(titleLike, 0, maxDepth, maxElements, interactiveOnly, compact, maxChars);
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

    // Входы по готовому HWND. Окно уже найдено через user32 (EnumWindows),
    // поэтому перебирать все окна средствами UIA не нужно.
    public static UiaResult RunTreeByHwnd(int timeoutMs, long hwnd, int maxDepth,
                                          int maxElements, bool interactiveOnly)
    {
        Func<object> job = delegate
        {
            return TreeJson("", hwnd, maxDepth, maxElements, interactiveOnly);
        };
        return Run(timeoutMs, job);
    }

    public static UiaResult RunTreeByHwndCompact(int timeoutMs, long hwnd, int maxDepth,
                                          int maxElements, bool interactiveOnly, bool compact,
                                          int maxChars)
    {
        Func<object> job = delegate
        {
            return TreeJson("", hwnd, maxDepth, maxElements, interactiveOnly, compact, maxChars);
        };
        return Run(timeoutMs, job);
    }

    public static UiaResult RunSearchByHwnd(int timeoutMs, long hwnd, string nameLike,
                                            string typeName, string automationId, int maxDepth, int limit)
    {
        Func<object> job = delegate
        {
            return SearchJson("", hwnd, nameLike, typeName, automationId, maxDepth, limit);
        };
        return Run(timeoutMs, job);
    }

    public static UiaResult RunResolveByHwnd(int timeoutMs, long hwnd, string nameLike,
                                             string typeName, string automationId, int maxDepth,
                                             int rectX, int rectY, int rectW, int rectH)
    {
        Func<object> job = delegate
        {
            return ResolveJson("", hwnd, nameLike, typeName, automationId, maxDepth,
                               rectX, rectY, rectW, rectH);
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

    // Список окон для обхода. При заданном hwnd берём только это окно через
    // FromHandle, без обращения к AutomationElement.RootElement.
    //
    // Почему это отдельный путь, а не мелочь: на машине, где висит
    // приложение, тормозящее UIA, ЛЮБОЕ касание RootElement стоит ~3 с
    // (замерено: FindAll по детям 3034 мс, FindFirst по имени 3016 мс,
    // FromHandle 40 мс, обход потомков из FromHandle 5 мс на 19 узлов).
    // То есть перебор всех окон в поисках одного окна и есть тот налог,
    // из-за которого named-вызов стоил 3 с вместо сотен миллисекунд.
    private static List<AutomationElement> WindowList(string titleLike, long hwnd)
    {
        List<AutomationElement> list = new List<AutomationElement>();
        if (hwnd != 0)
        {
            try { list.Add(AutomationElement.FromHandle(new IntPtr(hwnd))); }
            catch (Exception) { }
            return list;
        }
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
            list.Add(w);
        }
        return list;
    }

    public static string TreeJson(string titleLike, int maxDepth, int maxElements, bool interactiveOnly)
    {
        return TreeJson(titleLike, 0, maxDepth, maxElements, interactiveOnly);
    }

    public static string TreeJson(string titleLike, long hwnd, int maxDepth, int maxElements,
                                  bool interactiveOnly)
    {
        return TreeJson(titleLike, hwnd, maxDepth, maxElements, interactiveOnly, false, 0);
    }

    // compact: узлы позиционными массивами вместо объектов с именами полей.
    // maxChars: бюджет символов ответа, 0 = без ограничения. При обрезании
    // в ответе ставится truncated, чтобы вызывающий не принял короткий ответ
    // за полный.
    public static string TreeJson(string titleLike, long hwnd, int maxDepth, int maxElements,
                                  bool interactiveOnly, bool compact, int maxChars)
    {
        try
        {
            List<string> trees = new List<string>();
            Counter last = new Counter();
            CharBudget budget = new CharBudget();
            budget.Max = maxChars;

            List<AutomationElement> wins = WindowList(titleLike, hwnd);

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
                List<string> node = compact
                    ? BuildNodesCompact(w, 0, maxDepth, c, maxElements, interactiveOnly, budget)
                    : BuildNodes(w, 0, maxDepth, c, maxElements, interactiveOnly);
                if (!compact)
                {
                    for (int i = 0; i < node.Count; i++)
                        budget.Spent(node[i].Length);
                }
                for (int i = 0; i < node.Count; i++) trees.Add(node[i]);
                last = c;
                if (budget.Hit) break;
            }

            StringBuilder head = new StringBuilder(64);
            if (compact)
            {
                head.Append("{\"fields\":[\"name\",\"type\",\"automationId\",\"rect[x,y,w,h]\",");
                head.Append("\"flags 1=enabled 2=offscreen 4=selected 8=toggled\",\"patterns\",");
                head.Append("\"value or null (ValuePattern)\",\"text or null (TextPattern)\",\"children\"],");
                head.Append("\"windows\":");
            }
            else
            {
                head.Append("{\"windows\":");
            }
            head.Append(JoinArray(trees));
            head.Append(",\"elementsScanned\":").Append(Count(last.Value));
            if (budget.Hit)
            {
                head.Append(",\"truncated\":true,\"maxChars\":").Append(Count(maxChars));
            }
            head.Append('}');
            return head.ToString();
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

    // Компактная форма дерева. Узел отдаётся позиционным массивом вместо объекта
// с именованными полями: на том же окне это экономит больше половины символов,
    // потому что имена ключей повторяются на каждом узле.
    // Легенда полей отдаётся один раз в ответе, поэтому её не нужно знать
    // наизусть:
    //   0 name, 1 type, 2 automationId, 3 [x,y,w,h], 4 flags,
    //   5 patterns, 6 value (только у ValuePattern), 7 text (только у TextPattern),
    //   8 children
    // flags: бит 1 включён, 2 за экраном, 4 выделен, 8 переключатель во включённом.
    // Обход здесь намеренно повторяет BuildNodes: правка существующего билдера
    // заддела бы путь по умолчанию, а выигрыш нужен только в новой ветке.
    private sealed class CharBudget
    {
        public int Chars = 0;
        public int Max = 0;      // 0 = без ограничения
        public bool Hit = false;

        public bool Spent(int add)
        {
            Chars += add;
            if (Max > 0 && Chars >= Max) { Hit = true; return true; }
            return false;
        }

        public int Left
        {
            get { return Max <= 0 ? int.MaxValue : Max - Chars; }
        }
    }

    private static List<string> BuildNodesCompact(AutomationElement el, int depth, int maxDepth,
                                                 Counter c, int maxElements, bool interactiveOnly,
                                                 CharBudget budget)
    {
        if (depth > maxDepth) return new List<string>();
        if (c.Value >= maxElements) return new List<string>();
        if (budget.Hit) return new List<string>();

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
                while (child != null && c.Value < maxElements && !budget.Hit)
                {
                    List<string> sub = BuildNodesCompact(child, depth + 1, maxDepth, c,
                                                         maxElements, interactiveOnly, budget);
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

        Rect rc = SafeRect(el);

        // Все флаги собираются до записи узла: иначе переключатель и
        // выделение вычислялись бы уже после того, как флаг вписан в JSON.
        int flags = 0;
        try { if (info.IsEnabled) flags |= 1; } catch (Exception) { }
        try { if (info.IsOffscreen) flags |= 2; } catch (Exception) { }

        List<string> pats = new List<string>();
        string patJson = PatternsArray(el, pats);

        if (Has(pats, "TogglePattern"))
        {
            try
            {
                TogglePattern tp = el.GetCurrentPattern(TogglePattern.Pattern) as TogglePattern;
                if (tp != null && tp.Current.ToggleState.ToString() == "On") flags |= 8;
            }
            catch (Exception) { }
        }

        if (Has(pats, "SelectionItemPattern"))
        {
            try
            {
                SelectionItemPattern sp = el.GetCurrentPattern(SelectionItemPattern.Pattern) as SelectionItemPattern;
                if (sp != null && sp.Current.IsSelected) flags |= 4;
            }
            catch (Exception) { }
        }

        StringBuilder b = new StringBuilder(160);
        b.Append('[');
        b.Append(J(Trunc(rawName, 200))).Append(',');
        b.Append(J(ct)).Append(',');

        string aid = null;
        try { aid = info.AutomationId; } catch (Exception) { aid = null; }
        b.Append(J(aid)).Append(',');
        b.Append('[').Append(Coord(rc.X)).Append(',').Append(Coord(rc.Y)).Append(',')
         .Append(Coord(rc.Width)).Append(',').Append(Coord(rc.Height)).Append(']').Append(',');
        b.Append(flags).Append(',');
        b.Append(patJson.Length > 0 ? patJson : "[]");

        // value и text пишутся всегда, даже когда паттерна нет, иначе позиции
        // в массиве зависят от того, есть ли паттерн: у одного окна слот 6 это
        // значение, у другого текст, а у третьего дети. Легенда полей обещает
        // фиксированный порядок, и разбор по позициям обязан быть честным.
        b.Append(',');
        if (Has(pats, "ValuePattern"))
        {
            try
            {
                ValuePattern vp = el.GetCurrentPattern(ValuePattern.Pattern) as ValuePattern;
                b.Append(vp != null ? J(Trunc(vp.Current.Value, 300)) : "null");
            }
            catch (Exception) { b.Append("null"); }
        }
        else { b.Append("null"); }

        b.Append(',');
        if (Has(pats, "TextPattern"))
        {
            try
            {
                TextPattern tp = el.GetCurrentPattern(TextPattern.Pattern) as TextPattern;
                string txt = null;
                if (tp != null)
                {
                    TextPatternRange doc = tp.DocumentRange;
                    string full = doc.GetText(-1);
                    txt = Trunc(full, 300);
                }
                b.Append(txt != null ? J(txt) : "null");
            }
            catch (Exception) { b.Append("null"); }
        }
        else { b.Append("null"); }

        if (kids.Count > 0)
        {
            b.Append(",[");
            for (int i = 0; i < kids.Count; i++)
            {
                if (i > 0) b.Append(',');
                b.Append(kids[i]);
            }
            b.Append(']');
        }
        b.Append(']');

        string json = b.ToString();
        budget.Spent(json.Length);
        List<string> one = new List<string>();
        one.Add(json);
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

    // Только сам массив паттернов, без обёртки "patterns":. Нужно компактному
    // билдеру: AppendPatterns пишет именованный ключ, а в позиционном массиве
    // такой ключ ломает JSON.
    private static string PatternsArray(AutomationElement el, List<string> names)
    {
        AutomationPattern[] ps = null;
        try { ps = el.GetSupportedPatterns(); } catch (Exception) { ps = null; }
        if (ps == null) return "";
        for (int i = 0; i < ps.Length; i++) names.Add(PatternShort(ps[i]));
        if (names.Count == 0) return "";
        StringBuilder a = new StringBuilder(64);
        a.Append('[');
        for (int i = 0; i < names.Count; i++)
        {
            if (i > 0) a.Append(',');
            a.Append(J(names[i]));
        }
        a.Append(']');
        return a.ToString();
    }

    private static string SearchJson(string titleLike, string nameLike, string typeName,
                                    string automationId, int maxDepth, int limit)
    {
        return SearchJson(titleLike, 0, nameLike, typeName, automationId, maxDepth, limit);
    }

    // Поиск элемента и само действие на STA-потоке.
    //
    // Зачем: пока поиск делал PowerShell, его единственный runspace уходил в
    // UIA, и зависшее окно убивало воркер целиком вместе со всем состоянием
    // на inflight. Здесь и поиск, и Invoke/SetValue происходят на STA с
    // жёстким таймаутом, поэтому зависший элемент стоит одного потока, а
    // воркер переживает и поднимает новый поток для следующего вызова.
    //
    // Статусы: ok / notfound / disabled / noPattern / error / unknownAction.
    // PowerShell по ним решает, что делать дальше: отказаться, отдать
    // результат или откатиться на пиксельный клик.
    public static string ActJson(long hwnd, string action, string nameLike, string typeName,
                                 string automationId, int maxDepth, string value, int limit)
    {
        try
        {
            List<object[]> hits = SearchCore("", hwnd, nameLike, typeName, automationId, maxDepth, limit);
            if (hits.Count == 0) return "{\"status\":\"notfound\"}";

            if (action == "find")
            {
                StringBuilder items = new StringBuilder(256);
                for (int i = 0; i < hits.Count; i++)
                {
                    if (i > 0) items.Append(',');
                    items.Append(ElementInfoJson((AutomationElement)hits[i][0], (string)hits[i][1]));
                }
                return "{\"status\":\"ok\",\"count\":" + Count(hits.Count) + ",\"elements\":[" + items + "]}";
            }

            AutomationElement el = (AutomationElement)hits[0][0];
            string ct = (string)hits[0][1];
            string info = ElementInfoJson(el, ct);

            // Ложное «сработало» хуже отказа: InvokePattern на
            // заблокированном элементе в Windows возвращается довольным и
            // не делает ничего. Поэтому проверяем заранее.
            bool enabled;
            try { enabled = el.Current.IsEnabled; } catch (Exception) { enabled = false; }
            if (!enabled) return "{\"status\":\"disabled\",\"element\":" + info + "}";

            if (action == "invoke")
            {
                try
                {
                    InvokePattern ip = el.GetCurrentPattern(InvokePattern.Pattern) as InvokePattern;
                    if (ip == null) return "{\"status\":\"noPattern\",\"element\":" + info + "}";
                    ip.Invoke();
                    return "{\"status\":\"ok\",\"via\":\"InvokePattern\",\"element\":" + info + "}";
                }
                catch (Exception ex)
                {
                    return "{\"status\":\"error\",\"error\":" + J(ex.Message) + ",\"element\":" + info + "}";
                }
            }

            if (action == "set_value")
            {
                try
                {
                    ValuePattern vp = el.GetCurrentPattern(ValuePattern.Pattern) as ValuePattern;
                    if (vp == null) return "{\"status\":\"noPattern\",\"element\":" + info + "}";
                    vp.SetValue(value == null ? "" : value);
                    return "{\"status\":\"ok\",\"via\":\"ValuePattern\",\"element\":" + info + "}";
                }
                catch (Exception ex)
                {
                    return "{\"status\":\"error\",\"error\":" + J(ex.Message) + ",\"element\":" + info + "}";
                }
            }

            if (action == "select")
            {
                return SelectJson(el, ct, info, value);
            }

            return "{\"status\":\"unknownAction\",\"error\":" + J(action) + "}";
        }
        catch (Exception ex)
        {
            return "{\"status\":\"error\",\"error\":" + J(ex.GetType().Name + ": " + ex.Message) + "}";
        }
    }

    // Выбор значения в выпадающем списке, поле со списком или на вкладке.
    //
    // Именно этот кусок раньше был недостижим из PowerShell: SelectionItem
    // и ExpandCollapse вызываются на STA-потоке, а живой объект наружу не
    // отдаётся. Раскрытие, выбор и сворачивание обратно делаются здесь же,
    // наружу уходит только результат.
    private static string SelectJson(AutomationElement el, string ct, string info, string value)
    {
        string wanted = value == null ? "" : value;

        // Элемент, который не умеет выбор, нельзя чинить подбором потомков:
        // у кнопки нет ни одного паттерна выбора, и обход её потомков всегда
        // ничего не найдёт. Раньше такой вызов заканчивался «вариант не найден
        // среди элементов 'Закрыть'» — симптом вместо причины.
        try
        {
            AutomationPattern[] ps = el.GetSupportedPatterns();
            if (ps != null && ps.Length > 0)
            {
                bool selectable = false;
                for (int i = 0; i < ps.Length; i++)
                {
                    string n = PatternShort(ps[i]);
                    if (n == "SelectionItemPattern" || n == "ExpandCollapsePattern" ||
                        n == "ValuePattern" || n == "ListPattern" || n == "SelectionPattern")
                    {
                        selectable = true;
                        break;
                    }
                }
                if (!selectable)
                {
                    string ename = "";
                    try { ename = el.Current.Name ?? ""; } catch (Exception) { }
                    return "{\"status\":\"noPattern\",\"error\":" + J(
                        "Элемент '" + ename + "' не поддерживает выбор: у него нет ни SelectionItem, " +
                        "ни ExpandCollapse, ни List. Выбирать в нём нечего.") + "}";
                }
            }
        }
        catch (Exception)
        {
            // Сведений о паттернах нет — идём обычным путём и смотрим по факту.
        }

        ExpandCollapsePattern ec = null;
        bool expandedByUs = false;

        try
        {
            ec = el.GetCurrentPattern(ExpandCollapsePattern.Pattern) as ExpandCollapsePattern;
            if (ec != null && ec.Current.ExpandCollapseState != ExpandCollapseState.Expanded)
            {
                ec.Expand();
                expandedByUs = true;
            }
        }
        catch (Exception)
        {
        }

        AutomationElement found = null;
        try
        {
            PropertyCondition cond = new PropertyCondition(AutomationElement.NameProperty, wanted);
            found = el.FindFirst(TreeScope.Descendants, cond);
        }
        catch (Exception)
        {
        }

        if (found == null)
        {
            // Вариант может быть и самим элементом: у вкладки или пункта
            // списка SelectionItemPattern лежит на самом элементе, а у выпадающего
            // списка лежит на потомке. Поэтому сначала пробуем сам элемент.
            try
            {
                SelectionItemPattern self = el.GetCurrentPattern(SelectionItemPattern.Pattern)
                    as SelectionItemPattern;
                string selfName = "";
                try { selfName = el.Current.Name; } catch (Exception) { }
                if (self != null && !string.IsNullOrEmpty(selfName) &&
                    (selfName.IndexOf(wanted, StringComparison.OrdinalIgnoreCase) >= 0 ||
                     string.Equals(selfName, wanted, StringComparison.OrdinalIgnoreCase)))
                {
                    found = el;
                }
            }
            catch (Exception)
            {
            }
        }

        if (found == null && wanted.Length > 0)
        {
            // Имя может отличаться регистром или содержать хвост вроде
            // "DHL (Express)". Ищем вхождение, ограничивая обход.
            try
            {
                TreeWalker w = Walker();
                Stack<AutomationElement> stack = new Stack<AutomationElement>();
                AutomationElement first = el.FindFirst(TreeScope.Descendants, Condition.TrueCondition);
                if (first != null) stack.Push(first);
                int scanned = 0;
                while (stack.Count > 0 && scanned < 200)
                {
                    scanned++;
                    AutomationElement cur = stack.Pop();
                    string n = "";
                    try { n = cur.Current.Name; } catch (Exception) { }
                    if (!string.IsNullOrEmpty(n) &&
                        n.IndexOf(wanted, StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        found = cur;
                        break;
                    }
                    try
                    {
                        AutomationElement ch = w.GetFirstChild(cur);
                        while (ch != null) { stack.Push(ch); ch = w.GetNextSibling(ch); }
                    }
                    catch (Exception) { }
                }
            }
            catch (Exception)
            {
            }
        }

        if (found == null)
        {
            return "{\"status\":\"optionNotFound\",\"option\":" + J(wanted) +
                   ",\"element\":" + info + "}";
        }

        bool selected = false;
        string via = "SelectionItemPattern";
        try
        {
            SelectionItemPattern si = found.GetCurrentPattern(SelectionItemPattern.Pattern)
                as SelectionItemPattern;
            if (si != null)
            {
                si.Select();
                selected = si.Current.IsSelected;
            }
            else
            {
                via = "";
            }
        }
        catch (Exception ex)
        {
            try { if (ec != null && expandedByUs) ec.Collapse(); } catch (Exception) { }
            return "{\"status\":\"error\",\"error\":" + J(ex.Message) + ",\"element\":" + info + "}";
        }

        try { if (ec != null && expandedByUs) ec.Collapse(); } catch (Exception) { }

        if (!selected)
        {
            // Паттерн отработал без ошибки, но элемент не выбрался. Ложное
            // "сработало" хуже отказа, поэтому отдаём отдельный статус.
            return "{\"status\":\"notSelected\",\"via\":" + J(via) + ",\"element\":" + info + "}";
        }

        string chosen = "";
        try { chosen = found.Current.Name; } catch (Exception) { }
        return "{\"status\":\"ok\",\"selected\":true,\"via\":" + J(via) + ",\"selectedName\":" +
               J(chosen) + ",\"element\":" + info + "}";
    }

    // Таблица одним вызовом через нативные Grid/Table паттерны.
    //
    // Без этого чтение таблицы это либо огромное дерево, либо N*M вызовов
    // computer_find, либо OCR, который путает столбцы. GridPattern отдаёт
    // значения ячеек напрямую, это единственный способ получить строки и
    // заголовки без догадок по картинке.
    // Признака "эта строка является заголовком" у TablePatternInformation в
    // .NET нет вообще: у паттерна только RowCount, ColumnCount и
    // RowOrColumnMajor. Проверено рефлексией по типу. Поэтому первая строка
    // читается как заголовок по соглашению, а не по гарантии паттерна, и
    // параметр headers позволяет это отключить.
    private static string TableJson(long hwnd, string nameLike, string typeName,
                                   string automationId, int maxDepth,
                                   int maxRows, int maxColumns, bool headers)
    {
        List<object[]> hits = SearchCore("", hwnd, nameLike, typeName, automationId, maxDepth, 1);
        if (hits.Count == 0) return "{\"status\":\"notfound\"}";

        AutomationElement el = (AutomationElement)hits[0][0];
        string ct = (string)hits[0][1];
        string info = ElementInfoJson(el, ct);

        GridPattern grid = null;
        try { grid = el.GetCurrentPattern(GridPattern.Pattern) as GridPattern; } catch (Exception) { }
        if (grid == null)
        {
            return "{\"status\":\"notGrid\",\"error\":" +
                   J("У элемента нет GridPattern, читать таблицу нечем") +
                   ",\"element\":" + info + "}";
        }

        int rowCount = 0;
        int colCount = 0;
        try { rowCount = grid.Current.RowCount; } catch (Exception) { }
        try { colCount = grid.Current.ColumnCount; } catch (Exception) { }

        List<string> headRow = new List<string>();
        int rStart = 0;
        if (headers && rowCount > 0)
        {
            for (int c = 0; c < colCount && c < maxColumns; c++)
            {
                string hn = "";
                try { hn = grid.GetItem(0, c).Current.Name; } catch (Exception) { }
                headRow.Add(hn);
            }
            rStart = 1;
        }

        int rEnd = Math.Min(rowCount, rStart + maxRows);
        int cEnd = Math.Min(colCount, maxColumns);

        StringBuilder rows = new StringBuilder(256);
        for (int r = rStart; r < rEnd; r++)
        {
            if (r > rStart) rows.Append(',');
            rows.Append('[');
            for (int c = 0; c < cEnd; c++)
            {
                if (c > 0) rows.Append(',');
                string v = "";
                try { v = grid.GetItem(r, c).Current.Name; } catch (Exception) { }
                rows.Append(J(Trunc(v, 200)));
            }
            rows.Append(']');
        }

        // Заголовки экранируются явно. JoinArray склеивает уже готовые JSON-строки
        // и для сырых значений кавычки не ставит, из-за чего ответ перестаёт
        // быть валидным JSON: "headers":[ZX-4471-8820,Out for delivery,...]
        StringBuilder hArr = new StringBuilder(64);
        hArr.Append('[');
        for (int i = 0; i < headRow.Count; i++)
        {
            if (i > 0) hArr.Append(',');
            hArr.Append(J(headRow[i]));
        }
        hArr.Append(']');

        return "{\"status\":\"ok\",\"table\":{\"rowCount\":" + Count(rowCount) +
               ",\"columnCount\":" + Count(colCount) +
               ",\"headers\":" + hArr.ToString() +
               ",\"rows\":[" + rows.ToString() + "]" +
               ",\"truncated\":" + ((rowCount > rEnd) ? "true" : "false") +
               ",\"returnedRows\":" + Count(Math.Max(0, rEnd - rStart)) +
               ",\"headersByConvention\":true}" +
               ",\"element\":" + info + "}";
    }

    public static UiaResult RunTableByHwnd(int timeoutMs, long hwnd, string nameLike,
                                           string typeName, string automationId, int maxDepth,
                                           int maxRows, int maxColumns, bool headers)
    {
        Func<object> job = delegate
        {
            return TableJson(hwnd, nameLike, typeName, automationId, maxDepth, maxRows, maxColumns, headers);
        };
        return Run(timeoutMs, job);
    }

    public static UiaResult RunActByHwnd(int timeoutMs, long hwnd, string action, string nameLike,
                                          string typeName, string automationId, int maxDepth,
                                          string value, int limit)
    {
        Func<object> job = delegate
        {
            return ActJson(hwnd, action, nameLike, typeName, automationId, maxDepth, value, limit);
        };
        return Run(timeoutMs, job);
    }

    public static string SearchJson(string titleLike, long hwnd, string nameLike, string typeName,
                                    string automationId, int maxDepth, int limit)
    {
        try
        {
            List<object[]> hits = SearchCore(titleLike, hwnd, nameLike, typeName, automationId, maxDepth, limit);
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
        return ResolveJson(titleLike, 0, nameLike, typeName, automationId, maxDepth,
                           rectX, rectY, rectW, rectH);
    }

    public static string ResolveJson(string titleLike, long hwnd, string nameLike, string typeName,
                                     string automationId, int maxDepth,
                                     int rectX, int rectY, int rectW, int rectH)
    {
        try
        {
            List<object[]> hits = SearchCore(titleLike, hwnd, nameLike, typeName, automationId, maxDepth, 1);
            if (hits.Count == 0 && rectW > 0 && rectH > 0)
            {
                List<object[]> broad = SearchCore(titleLike, hwnd, "", typeName, "", maxDepth, 200);
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
        return SearchCore(titleLike, 0, nameLike, typeName, automationId, maxDepth, limit);
    }

    private static List<object[]> SearchCore(string titleLike, long hwnd, string nameLike, string typeName,
                                             string automationId, int maxDepth, int limit)
    {
        List<object[]> hits = new List<object[]>();

        List<AutomationElement> wins = WindowList(titleLike, hwnd);

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
