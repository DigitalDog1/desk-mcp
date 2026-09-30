$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$docs = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'docs'
New-Item -ItemType Directory -Force -Path $docs | Out-Null

$bg      = [System.Drawing.Color]::FromArgb(24, 26, 30)
$panel   = [System.Drawing.Color]::FromArgb(34, 38, 44)
$white   = [System.Drawing.Color]::FromArgb(222, 226, 232)
$gray    = [System.Drawing.Color]::FromArgb(158, 164, 174)
$green   = [System.Drawing.Color]::FromArgb(126, 200, 140)
$yellow  = [System.Drawing.Color]::FromArgb(224, 190, 120)
$cyan    = [System.Drawing.Color]::FromArgb(126, 190, 220)

$mono   = New-Object System.Drawing.Font('Consolas', 12)
$monoB  = New-Object System.Drawing.Font('Consolas', 12, [System.Drawing.FontStyle]::Bold)
$head   = New-Object System.Drawing.Font('Segoe UI Semibold', 14)
$small  = New-Object System.Drawing.Font('Segoe UI', 10)

function New-Sheet([int]$w, [int]$h) {
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
    $g.Clear($bg)
    return @($bmp, $g)
}

function Say($g, [string]$text, [int]$x, [int]$y, $font, $color) {
    if ($null -eq $text) { $text = '' }
    if ($null -eq $font) { $font = $small }
    $brush = New-Object System.Drawing.SolidBrush $color
    $g.DrawString($text, $font, $brush, $x, $y)
    $brush.Dispose()
}

function Save-Sheet($sheet, [string]$name) {
    $sheet[0].Save("$docs\$name", [System.Drawing.Imaging.ImageFormat]::Png)
    $sheet[0].Dispose()
    $sheet[1].Dispose()
}

# ---------- computer_find ----------
$s = New-Sheet 1100 620
$g = $s[1]
Say $g 'computer_find  { title: "Discord", type: "Button" }' 28 22 $monoB $yellow
$y = 60
foreach ($t in @(
    '{',
    '  "count": 3,',
    '  "elements": [',
    '    {',
    '      "name": "Почта",',
    '      "type": "Button",',
    '      "id": "view_1017",',
    '      "rect": { "x": 2152, "y": 184, "w": 40, "h": 24 },',
    '      "enabled": true,',
    '      "patterns": ["InvokePattern", "ScrollItemPattern"]',
    '    },',
    '    ... ещё два',
    '  ]',
    '}'
)) {
    $col = $white
    if ($t -match '"name"') { $col = $green }
    if ($t -match '"type"') { $col = $green }
    if ($t -match '"id"')    { $col = $green }
    if ($t -match '^\s+\.\.\.') { $col = $gray }
    Say $g $t 28 $y $mono $col
    $y += 22
}
Say $g 'таргетинг по смыслу: элемент найден по имени и роли, а не по координатам' 28 ($y + 20) $small $gray
Save-Sheet $s 'find.png'

# ---------- computer_ocr ----------
$s = New-Sheet 1100 540
$g = $s[1]
Say $g 'computer_ocr  { region: "0,0,2560,1440", lang: "ru-RU" }' 28 22 $monoB $yellow
Say $g 'читает пиксели движком, встроенным в Windows. ноль моделей, 248 мс' 28 48 $small $gray
$y = 92
Say $g '81 строка, 1230 символов за 248 мс' 28 $y $mono $cyan
$y += 34
foreach ($t in @('"Найти или начать беседу"', '"Друзья"', '"Nitro"', '"Магазин"', '"Задания"', '"Личные сообщения"')) {
    Say $g $t 28 $y $mono $green
    $y += 26
}
$y += 12
Say $g 'у каждой строки и каждого слова есть границы —' 28 $y $mono $gray
Say $g 'по границе слова можно кликнуть' 28 ($y + 26) $mono $gray
Say $g 'работает там, где нет ни UIA, ни MSAA: игры, видео, GPU-контент' 28 ($y + 74) $small $gray
Save-Sheet $s 'ocr.png'

# ---------- слои чтения ----------
$s = New-Sheet 1100 450
$g = $s[1]
Say $g 'три слоя чтения, переключаются автоматически' 28 22 $head $white
$y = 76
$layers = @(
    @('UIA',  'UI Automation: нативные окна, точные automationId и паттерны', $green),
    @('MSAA', 'oleacc, когда UIA отдала пустое дерево: Chromium без флага доступности', $yellow),
    @('CDP',  'Chrome DevTools Protocol: настоящий DOM с готовыми CSS-селекторами', $cyan)
)
foreach ($l in $layers) {
    $br = New-Object System.Drawing.SolidBrush $panel
    $g.FillRectangle($br, 28, ($y - 8), 1044, 84)
    $br.Dispose()
    Say $g $l[0] 48 ($y + 8) $monoB $l[2]
    Say $g $l[1] 150 ($y + 10) $mono $white
    $y += 104
}
Say $g 'пустой UIA — не ошибка, а сигнал переключиться на следующий слой' 28 ($y + 6) $small $gray
Save-Sheet $s 'layers.png'

Get-ChildItem $docs -Filter '*.png' | ForEach-Object { "{0}  {1} КБ" -f $_.Name, [math]::Round($_.Length / 1KB, 1) }
