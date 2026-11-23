param([string]$OutputDir)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using System.Windows.Forms;
public class DelayedPasteTextBox : TextBox {
 private Timer pendingPaste;
 public int Commits;
 protected override void WndProc(ref Message m) {
  if(m.Msg==0x0302) {
   string value=Clipboard.GetText();
   if(pendingPaste!=null){pendingPaste.Stop();pendingPaste.Dispose();}
   Text="";
   // Deliberately exceed ten 50 ms polling intervals: readiness is a time budget,
   // not an accidental consequence of repeatedly collecting expensive metadata.
   pendingPaste=new Timer{Interval=700};
   pendingPaste.Tick+=delegate {
    pendingPaste.Stop();pendingPaste.Dispose();pendingPaste=null;Commits++;Text=value;
   };
   pendingPaste.Start();
   return;
  }
  base.WndProc(ref m);
 }
 protected override void Dispose(bool disposing) {
  if(disposing && pendingPaste!=null){pendingPaste.Stop();pendingPaste.Dispose();}
  base.Dispose(disposing);
 }
}
public class HardeningForm : Form {
 [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int n);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern bool GetCursorPos(out Point p);
 public string Dir, Label;
 public TextBox Input, Digits, ReadOnlyInput, DisabledInput;
 public DelayedPasteTextBox DelayedPaste;
 public int Clicks;
 public bool OtherClosed;
 public HardeningForm(string dir,string label,int x,bool large) {
  Dir=dir; Label=label; Text="desk-mcp regression "+label;
  ClientSize=new Size(700,650); Location=new Point(x,160); StartPosition=FormStartPosition.Manual;
  Input=new TextBox {Name="txtMain",Location=new Point(30,30),Width=350,Text="seed"}; Controls.Add(Input);
  var b=new Button {Name="btnOk",Text="Target button",Location=new Point(420,25),Size=new Size(180,45)};
  b.Click+=delegate {Clicks++; Save();}; Controls.Add(b);
  var combo=new ComboBox {Name="cmbOptions",Location=new Point(30,85),Width=220,DropDownStyle=ComboBoxStyle.DropDownList};
  combo.Items.AddRange(new object[]{"Alpha","Beta","Gamma"});combo.SelectedIndex=0;Controls.Add(combo);
  var tabs=new TabControl {Name="tabsMain",Location=new Point(300,85),Size=new Size(300,100)};
  tabs.TabPages.Add("First");tabs.TabPages.Add("Second");Controls.Add(tabs);
  var hang=new Button{Name="btnHang",Text="Hang fixture",Location=new Point(30,140),Width=180};
  hang.Click+=delegate {System.Threading.Thread.Sleep(15000);};Controls.Add(hang);
  DelayedPaste=new DelayedPasteTextBox{Name="txtDelayedPaste",Location=new Point(30,112),Width=220,Text="pending-seed"};Controls.Add(DelayedPaste);
  if(large){var list=new ListView{Name="lvData",View=View.Details,Location=new Point(30,220),Size=new Size(620,380)};
   list.Columns.Add("Name",250);list.Columns.Add("Value",200);
   for(int i=0;i<800;i++)list.Items.Add(new ListViewItem(new string[]{"row-"+i,i.ToString()}));
   Controls.Add(list);}
  ReadOnlyInput = new TextBox {Name="txtReadonly",Location=new Point(30,185),Width=350,Text="immutable",ReadOnly=true}; Controls.Add(ReadOnlyInput);
  DisabledInput = new TextBox {Name="txtDisabled",Location=new Point(220,135),Width=70,Text="disabled-seed",Enabled=false}; Controls.Add(DisabledInput);
  Digits = new TextBox {Name="txtDigits",Location=new Point(400,185),Width=180,Text="123"};
  Digits.KeyPress+=delegate(object sender, KeyPressEventArgs e) { if (!char.IsDigit(e.KeyChar) && !char.IsControl(e.KeyChar)) e.Handled=true; }; Controls.Add(Digits);
  // Paste bypasses KeyPress. Validate the resulting value too, so both input modes
  // exercise an application that rejects input after Windows has accepted the events.
  Digits.TextChanged+=delegate {
   string clean=System.Text.RegularExpressions.Regex.Replace(Digits.Text,@"\D","");
   if(clean!=Digits.Text){int caret=Digits.SelectionStart;Digits.Text=clean;Digits.SelectionStart=Math.Min(caret,clean.Length);}
   Save();
  };
  Input.TextChanged+=delegate {Save();};
  DelayedPaste.TextChanged+=delegate {Save();};
  var timer=new Timer{Interval=50};timer.Tick+=delegate {Save();}; timer.Start();
 }
 protected override void OnShown(EventArgs e){base.OnShown(e);ShowWindow(Handle,4);Save();}
 public void Save(){try {Point p;GetCursorPos(out p);var d=new Dictionary<string,object>();
  d["hwnd"]=Handle.ToInt64();d["otherClosed"]=OtherClosed;d["x"]=Left;d["y"]=Top;d["width"]=Width;d["height"]=Height;d["value"]=Input.Text;d["digits"]=Digits == null ? "123" : Digits.Text;d["readOnlyValue"]=ReadOnlyInput.Text;d["disabledValue"]=DisabledInput.Text;d["clicks"]=Clicks;d["foreground"]=GetForegroundWindow().ToInt64();d["cursorX"]=p.X;d["cursorY"]=p.Y;
  d["delayedValue"]=DelayedPaste.Text;d["delayedCommits"]=DelayedPaste.Commits;
  File.WriteAllText(Path.Combine(Dir,Label+".json"),new JavaScriptSerializer().Serialize(d));}catch{}}
}
'@ -ReferencedAssemblies System.Windows.Forms,System.Drawing,System.Web.Extensions
[System.Windows.Forms.Application]::EnableVisualStyles()
$a=New-Object HardeningForm($OutputDir,'A',80,$false)
$b=New-Object HardeningForm($OutputDir,'B',850,$true)
$b.add_FormClosed({ $a.OtherClosed = $true })
$b.Show()
[System.Windows.Forms.Application]::Run($a)
