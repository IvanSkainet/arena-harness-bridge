# Установка Arena Harness Bridge на Windows

Комплект v0.1.0 содержит плагин Desktop 0.1.10, его Python-компаньон и расширение Chrome 0.1.38. Проверенная версия DeepSeek Harness Desktop — 0.2.2-rc.5.

## Что понадобится

- Штатный DeepSeek Harness Desktop для Windows и Google Chrome.
- Python в `PATH`. Проверьте командой `python --version`. Комплект проверяется с Python 3.14.
- Доступ к Arena Agent Mode в Chrome. Вход и проверку личности, если она появляется, выполняйте в браузере.
- Доступ к npm-реестру при установке зависимостей плагина штатным CLI Desktop.

## Установка плагина

1. Распакуйте ZIP в постоянную папку. Desktop сохраняет путь к архиву плагина в зависимостях своего профиля.
2. Запустите DeepSeek Harness Desktop один раз для создания его профиля. Если появляется экран приветствия, можно выбрать **Добавить ключ API → Настроить позже**. Полностью выйдите из Desktop через меню приложения или значок в области уведомлений.
3. Откройте PowerShell в распакованной папке. Если команда `dsh` доступна, выполните:

   ```powershell
   $package = (Resolve-Path '.\dsh-arena-desktop-0.1.10.tgz').Path
   dsh plugin --profile desktop add $package
   ```

   Если `dsh` отсутствует в `PATH`, укажите путь к вашему `DeepSeek Harness.exe` и запустите встроенный CLI:

   ```powershell
   $desktop = 'C:\путь\к\DeepSeek Harness.exe'
   $dsh = Join-Path (Split-Path -Parent $desktop) 'resources\runtime\cli\bin\dsh.cmd'
   $package = (Resolve-Path '.\dsh-arena-desktop-0.1.10.tgz').Path
   & $dsh plugin --profile desktop add $package
   ```

4. Снова запустите Desktop, откройте рабочую папку и выберите **Arena Agent Mode** в селекторе моделей.

В версии 0.2.2-rc.5 pnpm может показать предупреждение о peer-зависимости `@deepseek-ai/dsh-llm`. В проверенном профиле плагин использовал пакет из установленного Desktop. Критерий успешной установки — появление модели **Arena Agent Mode** и команды `/arena-pair` после перезапуска.

## Расширение и первый запрос

1. Откройте `chrome://extensions`, включите режим разработчика и через **Загрузить распакованное расширение** выберите папку `browser-extension` из ZIP.
2. Откройте нужный разговор в Arena Agent Mode. Для нового разговора дождитесь первого ответа и адреса вида `https://arena.ai/agent/<id>`, затем обновите вкладку.
3. В целевом разговоре Desktop выберите **Connect Arena / Подключить Arena** через `/arena-pair`. Нажмите **Copy pairing token**.
4. В Chrome откройте **Arena Harness Bridge**, выберите нужный разговор, вставьте токен и нажмите **Bind conversation**.
5. Отправьте в Desktop короткую просьбу ответить одной строкой. Проверьте сообщение во вкладке Arena и ответ в Desktop.

Плагин сам запускает поставляемый Python-компаньон. Если Python установлен по нестандартному пути, укажите его через `ARENA_PYTHON` в окружении запуска Desktop. Если порт `127.0.0.1:8766` занят другим экземпляром моста, завершите тот экземпляр перед сопряжением.

Для отвязки откройте `/arena-pair` в исходном разговоре и нажмите **Disconnect and stop pending delivery**. Для удаления плагина выйдите из Desktop и выполните `dsh plugin --profile desktop remove dsh-arena-desktop` тем же CLI. Расширение удаляется на `chrome://extensions`.
