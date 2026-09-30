# Changelog

## 1.0.0

Первый публичный релиз.

### Наблюдение
- UI Automation → MSAA → Chrome DevTools Protocol: три слоя чтения подряд.
  MSAA включается автоматически, если UIA вернула пустое дерево (Chromium
  без `--force-renderer-accessibility`), с автоматическим наращиванием
  глубины обхода.
- `computer_read_screen`, `computer_find`, `computer_element_at`,
  `computer_browser_tree` — дерево UI и DOM с готовыми дескрипторами.
- `computer_ocr` — текст прямо из пикселей через движок, встроенный в
  Windows (`Windows.Media.Ocr`, ru/en). Ноль моделей.
- `computer_screenshot` — экран, произвольная область или конкретное окно
  через `PrintWindow` (работает на перекрытом и свёрнутом окне).

### Действие
- Ввод текста через `SendInput` + `KEYEVENTF_UNICODE` — кириллица работает,
  `SendKeys` её не берёт.
- `key_down`/`key_up` для удержания, модификаторы в клике, drag,
  `mouse_down`/`mouse_up`, колесо, `wait`.
- `computer_invoke` жмёт через `InvokePattern` **без захвата мыши**;
  `set_value` пишет через `ValuePattern` без фокуса.
- `computer_batch` — до 50 инструментов за один вызов, с остановкой на
  первой ошибке и результатом по каждому шагу.

### Проверка и надёжность
- `computer_verify_state` — предикаты: существует / `value_equals` /
  `enabled` / `selected`; `unknown` честно отличается от успеха.
- CDP-клик с двойным доказательством: проба в странице **или** смена URL.
- Таймаут вызова убивает зависший воркер и поднимает новый; после пяти
  зависаний подряд — пауза 30 с вместо отказа.
- `computer_close_window` и `computer_launch` требуют `confirm: true`.

### Ограничения (осознанные)
- Эксклюзивный полный экран: нужен DXGI Desktop Duplication, не делаем.
- Виртуальные рабочие столы: зависят от сборки Windows.
- UWP-окна не отдают ни UIA, ни MSAA-дерево.