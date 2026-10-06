# desk-mcp font benchmark application
#
# A WinForms window containing 246 TTF fonts from C:\Windows\Fonts.
# Used to benchmark tasks where target coordinates cannot be guessed by eye
# and must be found from structured data vs. pixel scanning.
#
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if (-not ("FontCatalogForm" -as [type])) {
Add-Type -TypeDefinition @"
using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

public class FontCatalogForm : Form {
    int events = 0;
    string resultFile;

    public void Note(string what) {
        events++;
        var lbl = Controls["lblStatus"] as Label;
        var log = Controls["log"] as TextBox;
        if (log != null) log.AppendText(what + Environment.NewLine);
    }

    public FontCatalogForm(string resPath) {
        resultFile = resPath;
        Text = "Font Catalog - desk-mcp benchmark";
        ClientSize = new Size(880, 560);
        StartPosition = FormStartPosition.Manual;
        Location = new Point(80, 80);
        Font = new Font("Segoe UI", 10F);
        MinimumSize = new Size(800, 500);

        var title = new Label();
        title.Text = "Font Catalog";
        title.Name = "lblTitle";
        title.Font = new Font("Segoe UI Semibold", 14F);
        title.AutoSize = true;
        title.Location = new Point(20, 14);
        Controls.Add(title);

        var sub = new Label();
        sub.Text = "246 TTF fonts from C:\\Windows\\Fonts. Find and select the target font.";
        sub.Name = "lblSubtitle";
        sub.AutoSize = true;
        sub.ForeColor = SystemColors.GrayText;
        sub.Location = new Point(22, 46);
        Controls.Add(sub);

        var list = new ListView();
        list.Name = "listFonts";
        list.View = View.Details;
        list.FullRowSelect = true;
        list.GridLines = true;
        list.Location = new Point(22, 76);
        list.Size = new Size(650, 360);
        list.Columns.Add("Filename", 220);
        list.Columns.Add("Size (bytes)", 160);
        list.Columns.Add("Date Modified", 180);

        string fontsDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), "Fonts");
        if (Directory.Exists(fontsDir)) {
            DirectoryInfo di = new DirectoryInfo(fontsDir);
            FileInfo[] files = di.GetFiles("*.ttf");
            Array.Sort(files, delegate(FileInfo a, FileInfo b) {
                return string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase);
            });
            for (int i = 0; i < files.Length; i++) {
                FileInfo fi = files[i];
                ListViewItem item = new ListViewItem(new string[] {
                    fi.Name,
                    fi.Length.ToString(),
                    fi.LastWriteTime.ToString("yyyy-MM-dd")
                });
                item.Name = fi.Name;
                list.Items.Add(item);
            }
        }
        Controls.Add(list);

        var btnSelect = new Button();
        btnSelect.Text = "Select Font";
        btnSelect.Name = "btnSelect";
        btnSelect.Location = new Point(690, 76);
        btnSelect.Size = new Size(160, 36);
        btnSelect.Click += delegate(object sender, EventArgs e) {
            if (list.SelectedItems.Count > 0) {
                string name = list.SelectedItems[0].Text;
                string size = list.SelectedItems[0].SubItems[1].Text;
                var lbl = Controls["lblStatus"] as Label;
                if (lbl != null) lbl.Text = "Selected: " + name + " (" + size + " bytes)";
                try {
                    File.WriteAllText(resultFile, name);
                    Clipboard.SetText(name);
                } catch { }
                Note("SELECTED:" + name + ":" + size);
            } else {
                Note("SELECT_CLICK_NO_SELECTION");
            }
        };
        Controls.Add(btnSelect);

        var btnReset = new Button();
        btnReset.Text = "Reset";
        btnReset.Name = "btnReset";
        btnReset.Location = new Point(690, 122);
        btnReset.Size = new Size(160, 32);
        btnReset.Click += delegate(object sender, EventArgs e) {
            list.SelectedIndices.Clear();
            var lbl = Controls["lblStatus"] as Label;
            if (lbl != null) lbl.Text = "No font selected.";
            try {
                if (File.Exists(resultFile)) File.Delete(resultFile);
                Clipboard.Clear();
            } catch { }
            Note("RESET");
        };
        Controls.Add(btnReset);

        var lblStatus = new Label();
        lblStatus.Text = "No font selected.";
        lblStatus.Name = "lblStatus";
        lblStatus.AutoSize = true;
        lblStatus.Location = new Point(22, 448);
        lblStatus.Font = new Font("Segoe UI Semibold", 10F);
        Controls.Add(lblStatus);

        var log = new TextBox();
        log.Name = "log";
        log.Location = new Point(22, 476);
        log.Size = new Size(828, 60);
        log.Multiline = true;
        log.ReadOnly = true;
        log.ScrollBars = ScrollBars.Vertical;
        Controls.Add(log);
    }
}
"@ -ReferencedAssemblies System.Windows.Forms, System.Drawing
}

$resPath = Join-Path $env:TEMP 'desk-mcp-font-result.txt'
if (Test-Path $resPath) { Remove-Item $resPath -Force }

[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object FontCatalogForm($resPath)
[System.Windows.Forms.Application]::Run($form)
