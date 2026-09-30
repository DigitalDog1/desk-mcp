# Атрибуция

Код проекта написан с нуля. Ниже — источники идей, на которые он опирается,
и лицензии используемых зависимостей.

## Идеи, заимствованные у других проектов

- **[virajshoor/opencode-computer-use](https://github.com/virajshoor/opencode-computer-use)** (MIT) —
  архитектура «MCP-обёртка + нативный помощник» и цикл
  Observe → Target (дерево доступности) → Act → Verify. Конкретный код не
  копировался: реализация самостоятельная, Windows и WinAPI вместо macOS.
- **[Cua Driver](https://github.com/trycua/cua)** (MIT) — идея двойного
  подтверждения действия: проба в целевой странице плюс проверка
  сопутствующего признака (в нашем случае смена `location.href`).
- **[CursorTouch/Windows-MCP](https://github.com/cursortouch/windows-mcp)** (MIT),
  **[zavora-ai/computer-use-mcp](https://github.com/zavora-ai/computer-use-mcp)** (MIT),
  **[harusame64/desktop-touch-mcp](https://github.com/harusame64/desktop-touch-mcp)** —
  использованы как образец и как предмет сравнения при аудите. Ни одна строка
  кода оттуда не скопирована.

## Зависимости

| Пакет | Лицензия |
|---|---|
| `@modelcontextprotocol/sdk` | MIT |
| `zod` | MIT |

## Системные API

Используются только публичные интерфейсы Windows: `user32`, `gdi32`,
`oleacc` (MSAA), UI Automation (`UIAutomationClient`/`UIAutomationTypes`),
Windows.Media.Ocr, Chrome DevTools Protocol. Сторонних бинарных
зависимостей нет: только Node.js и встроенный в Windows PowerShell 5.1.
