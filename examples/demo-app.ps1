# desk-mcp demo application
#
# A small WinForms window used to reproduce the README examples: it exposes
# real UIA patterns (buttons, edit, checkbox, combo box, list box, tab control)
# and logs every action into the window itself, so an agent driving it leaves
# visible evidence.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -STA -File examples\demo-app.ps1
#
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if (-not ("DemoForm" -as [type])) {
Add-Type -TypeDefinition @"
using System;
using System.Drawing;
using System.Windows.Forms;

public class DemoForm : Form {
    int events = 0;

    void Note(string what) {
        events++;
        var lbl = Controls["status"] as Label;
        if (lbl != null) lbl.Text = "events: " + events;
        var log = Controls["log"] as TextBox;
        if (log != null) log.AppendText(what + System.Environment.NewLine);
    }

    public DemoForm() {
        Text = "Parcel Tracker - desk-mcp demo";
        ClientSize = new Size(920, 600);
        StartPosition = FormStartPosition.Manual;
        Location = new Point(60, 60);
        Font = new Font("Segoe UI", 10F);
        MinimumSize = new Size(940, 640);

        var title = new Label {
            Text = "Parcel Tracker",
            Name = "lblTitle",
            Font = new Font("Segoe UI Semibold", 15F),
            AutoSize = true,
            Location = new Point(20, 16)
        };
        Controls.Add(title);

        var sub = new Label {
            Text = "Local demo window. Every action is logged below.",
            Name = "lblSubtitle",
            AutoSize = true,
            ForeColor = SystemColors.GrayText,
            Location = new Point(22, 48)
        };
        Controls.Add(sub);

        var searchLbl = new Label {
            Text = "Tracking number:",
            Name = "lblTracking",
            AutoSize = true,
            Location = new Point(22, 88)
        };
        Controls.Add(searchLbl);

        var search = new TextBox {
            Name = "searchBox",
            Location = new Point(150, 84),
            Size = new Size(300, 28)
        };
        Controls.Add(search);

        var btnSearch = new Button {
            Text = "Search",
            Name = "btnSearch",
            Location = new Point(462, 82),
            Size = new Size(120, 32)
        };
        btnSearch.Click += (s, e) => Note("SEARCH:" + search.Text);
        Controls.Add(btnSearch);

        // Список объявляем до кнопок: в C# 5 анонимный метод не может
        // ссылаться на локальную переменную, объявленную ниже него.
        var list = new ListBox {
            Name = "listParcels",
            Location = new Point(22, 200),
            Size = new Size(430, 150)
        };
        list.Items.AddRange(new object[] {
            "ZX-4471-8820  out for delivery",
            "ZX-1180-3395  delivered",
            "ZX-9026-1147  waiting in depot",
            "ZX-6633-2208  out for delivery",
            "ZX-5519-7042  label created"
        });
        list.SelectedIndex = 0;
        list.SelectedIndexChanged += (s, e) => Note("PICK:" + list.SelectedItem);
        Controls.Add(list);

        var btnRefresh = new Button {
            Text = "Refresh list",
            Name = "btnRefresh",
            Location = new Point(594, 82),
            Size = new Size(140, 32)
        };
        btnRefresh.Click += (s, e) => {
            list.Items.Clear();
            list.Items.AddRange(new object[] {
                "ZX-4471-8820  out for delivery",
                "ZX-1180-3395  delivered",
                "ZX-9026-1147  waiting in depot",
                "ZX-6633-2208  out for delivery",
                "ZX-5519-7042  label created"
            });
            // Без этого SelectedItem после перезагрузки null, и следующее
            // действие попадает в лог как "DELIVERED:" с пустым хвостом.
            list.SelectedIndex = 0;
            Note("REFRESH:5 parcels loaded");
        };
        Controls.Add(btnRefresh);

        var carrierLbl = new Label {
            Text = "Carrier:",
            Name = "lblCarrier",
            AutoSize = true,
            Location = new Point(22, 132)
        };
        Controls.Add(carrierLbl);

        var carrier = new ComboBox {
            Name = "comboCarrier",
            Location = new Point(150, 128),
            Size = new Size(180, 28),
            DropDownStyle = ComboBoxStyle.DropDownList
        };
        carrier.Items.AddRange(new object[] { "DHL", "FedEx", "UPS", "USPS" });
        carrier.SelectedIndex = 0;
        carrier.SelectedIndexChanged += (s, e) => Note("CARRIER:" + carrier.SelectedItem);
        Controls.Add(carrier);

        var notify = new CheckBox {
            Text = "Notify me on delivery",
            Name = "checkNotify",
            Location = new Point(360, 130),
            AutoSize = true
        };
        notify.CheckedChanged += (s, e) => Note("NOTIFY:" + notify.Checked);
        Controls.Add(notify);

        var listLbl = new Label {
            Text = "Recent parcels:",
            Name = "lblParcels",
            AutoSize = true,
            Location = new Point(22, 176)
        };
        Controls.Add(listLbl);

        var tabs = new TabControl {
            Name = "tabsDetails",
            Location = new Point(480, 176),
            Size = new Size(410, 176)
        };

        var tabDetail = new TabPage { Text = "Details", Name = "tabDetail" };
        var dName = new Label {
            Text = "Status: out for delivery",
            Name = "lblStatus",
            AutoSize = true,
            Location = new Point(18, 34)
        };
        tabDetail.Controls.Add(dName);

        var btnCopy = new Button {
            Text = "Copy tracking number",
            Name = "btnCopyTracking",
            Location = new Point(18, 66),
            Size = new Size(200, 32)
        };
        btnCopy.Click += (s, e) => {
            try {
                System.Windows.Forms.Clipboard.SetText("ZX-4471-8820");
                Note("COPY:ZX-4471-8820");
            } catch (Exception ex) {
                Note("COPY-FAILED:" + ex.Message);
            }
        };
        tabDetail.Controls.Add(btnCopy);

        var btnDeliver = new Button {
            Text = "Mark as delivered",
            Name = "btnDeliver",
            Location = new Point(234, 66),
            Size = new Size(160, 32)
        };
        btnDeliver.Click += (s, e) => {
            dName.Text = "Status: delivered";
            Note("DELIVERED:" + (list.SelectedItem ?? ""));
        };
        tabDetail.Controls.Add(btnDeliver);
        tabs.TabPages.Add(tabDetail);

        var tabHistory = new TabPage { Text = "History", Name = "tabHistory" };
        var hLbl = new Label {
            Text = "No scans recorded yet.",
            Name = "lblHistory",
            AutoSize = true,
            Location = new Point(18, 34)
        };
        tabHistory.Controls.Add(hLbl);

        // ListView в режиме Details, а не DataGridView. DataGridView отдаёт
        // GridPattern через UIA только когда подсистема доступности
        // инициализирована, а нативный список Windows отдаёт его всегда.
        // Проверено: DataGridView в этом окне вернул "нет GridPattern".
        var grid = new ListView();
        grid.Name = "listScans";
        grid.View = View.Details;
        grid.FullRowSelect = true;
        grid.GridLines = true;
        grid.Location = new Point(14, 58);
        grid.Size = new Size(360, 100);
        grid.Columns.Add("Tracking", 110);
        grid.Columns.Add("Status", 100);
        grid.Columns.Add("Last scan", 100);
        grid.Columns.Add("Depot", 90);
        grid.Items.Add(new ListViewItem(new string[] { "ZX-4471-8820", "Out for delivery", "2026-10-05 18:12", "Brockhaven" }));
        grid.Items.Add(new ListViewItem(new string[] { "ZX-1180-3395", "Delivered", "2026-10-04 09:41", "Riverton" }));
        grid.Items.Add(new ListViewItem(new string[] { "ZX-9026-1147", "In depot", "2026-10-05 07:03", "Brockhaven" }));
        grid.Items.Add(new ListViewItem(new string[] { "ZX-6633-2208", "Out for delivery", "2026-10-05 16:55", "Milvale" }));
        grid.Items.Add(new ListViewItem(new string[] { "ZX-5519-7042", "Label created", "2026-10-03 21:20", "Riverton" }));
        grid.Items.Add(new ListViewItem(new string[] { "ZX-2204-8817", "Out for delivery", "2026-10-05 19:02", "Milvale" }));
        tabHistory.Controls.Add(grid);
        tabs.TabPages.Add(tabHistory);

        tabs.SelectedIndexChanged += (s, e) => Note("TAB:" + tabs.SelectedIndex);
        Controls.Add(tabs);

        var logLbl = new Label {
            Text = "Action log:",
            Name = "lblLog",
            AutoSize = true,
            Location = new Point(22, 368)
        };
        Controls.Add(logLbl);

        var log = new TextBox {
            Name = "log",
            Location = new Point(22, 392),
            Size = new Size(868, 150),
            Multiline = true,
            ReadOnly = true,
            ScrollBars = ScrollBars.Vertical,
            BackColor = SystemColors.Window,
            Font = new Font("Consolas", 10F)
        };
        Controls.Add(log);

        var status = new Label {
            Text = "events: 0",
            Name = "status",
            AutoSize = true,
            Location = new Point(22, 556)
        };
        Controls.Add(status);
    }
}
"@ -ReferencedAssemblies System.Windows.Forms, System.Drawing
}

[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object DemoForm
[System.Windows.Forms.Application]::Run($form)