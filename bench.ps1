$ErrorActionPreference = 'Stop'
$log = Join-Path $env:TEMP 'desk-mcp-bench.log'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if (-not ("BenchForm" -as [type])) {
Add-Type -TypeDefinition @"
using System;
using System.Drawing;
using System.Windows.Forms;

public class BenchForm : Form {
    public System.Collections.Generic.List<string> Evts = new System.Collections.Generic.List<string>();

    void Note(string s) {
        Evts.Add(s);
        var lbl = Controls["status"] as Label;
        if (lbl != null) lbl.Text = "событий: " + Evts.Count;
        BenchLog.Write(s);
    }

    public BenchForm() {
        Text = "desk-mcp bench";
        ClientSize = new Size(760, 460);
        StartPosition = FormStartPosition.Manual;
        Location = new Point(40, 40);
        Font = new Font("Segoe UI", 11F);

        var lbl = new Label { Text = "Тестовый стенд desk-mcp", Name = "title", AutoSize = true, Location = new Point(20, 16) };
        Controls.Add(lbl);

        var b1 = new Button { Text = "Кнопка один", Name = "btnOne", Location = new Point(20, 56), Size = new Size(200, 42) };
        b1.Click += (s, e) => Note("CLICK:btnOne");
        Controls.Add(b1);

        var b2 = new Button { Text = "Кнопка два", Name = "btnTwo", Location = new Point(240, 56), Size = new Size(200, 42) };
        b2.Click += (s, e) => Note("CLICK:btnTwo");
        Controls.Add(b2);

        var cb = new CheckBox { Name = "checkOne", Text = "Флажок один", Location = new Point(460, 66), AutoSize = true };
        cb.CheckedChanged += (s, e) => Note("CHECK:checkOne:" + cb.Checked);
        Controls.Add(cb);

        var ed = new TextBox { Name = "fieldOne", Location = new Point(20, 120), Size = new Size(420, 30) };
        Controls.Add(ed);

        var cbx = new ComboBox { Name = "comboOne", Location = new Point(20, 172), Size = new Size(220, 30), DropDownStyle = ComboBoxStyle.DropDownList };
        cbx.Items.AddRange(new object[] { "Вариант А", "Вариант Б", "Вариант В" });
        cbx.SelectedIndex = 0;
        cbx.SelectedIndexChanged += (s, e) => Note("SELECT:comboOne:" + cbx.SelectedItem);
        Controls.Add(cbx);

        var lb = new ListBox { Name = "listOne", Location = new Point(270, 172), Size = new Size(250, 130) };
        lb.Items.AddRange(new object[] { "Строка один", "Строка два", "Строка три" });
        lb.SelectedIndex = 0;
        lb.SelectedIndexChanged += (s, e) => Note("SELECT:listOne:" + lb.SelectedItem);
        Controls.Add(lb);

        var tabs = new TabControl { Name = "tabsOne", Location = new Point(20, 320), Size = new Size(500, 120) };
        var t1 = new TabPage { Text = "Вкладка один" };
        var inner = new Button { Text = "Внутренняя кнопка", Name = "btnInner", Location = new Point(20, 30), Size = new Size(200, 40) };
        inner.Click += (s, e) => Note("CLICK:btnInner");
        t1.Controls.Add(inner);
        tabs.TabPages.Add(t1);
        tabs.SelectedIndexChanged += (s, e) => Note("TAB:" + tabs.SelectedIndex);
        Controls.Add(tabs);

        var status = new Label { Name = "status", Text = "событий: 0", AutoSize = true, Location = new Point(20, 450) };
        Controls.Add(status);

        Shown += (s, e) => BenchLog.Write("SHOWN visible=" + Visible + " handle=" + Handle + " bounds=" + Bounds.ToString());
        FormClosed += (s, e) => BenchLog.Write("CLOSED");
    }
}

public static class BenchLog {
    public static string Path = "";
    public static void Write(string s) {
        if (String.IsNullOrEmpty(Path)) return;
        try {
            System.IO.File.AppendAllText(Path, DateTime.Now.ToString("HH:mm:ss.fff") + " " + s + System.Environment.NewLine);
        } catch { }
    }
}
"@ -ReferencedAssemblies System.Windows.Forms, System.Drawing
}

[BenchLog]::Path = $log
if (Test-Path $log) { Remove-Item $log -Force }

[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object BenchForm
[System.Windows.Forms.Application]::Run($form)
