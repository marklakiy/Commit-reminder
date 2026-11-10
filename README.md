# Commit Reminder

Плагин для VS Code, который напоминает сделать коммит, если в git-репозитории накопилось много незакоммиченных изменений. Лабораторная работа по ИСРПО.

## Что умеет

- Каждые N минут проверяет `git status` и, если изменённых файлов много, показывает уведомление с кнопками «Перейти к коммиту» и «Отложить».
- Показывает число изменённых файлов в строке состояния (жёлтым, когда пора коммитить).
- Собирает статистику: напоминания, коммиты, отложенные напоминания, нажатия на кнопку коммита, рекорд изменённых файлов.
- Рисует графики: напоминания и коммиты по дням, коммиты по часам суток.
- 21 настройка, их можно менять двумя способами:
  1. в обычном окне настроек (`Ctrl+,` → поиск `commitReminder`);
  2. через команду «Commit Reminder: Быстрые настройки» (меню выбора прямо в VS Code).

## Команды (Ctrl+Shift+P)

| Команда | Что делает |
|---|---|
| Commit Reminder: Проверить сейчас | Проверить репозиторий прямо сейчас |
| Commit Reminder: Показать статистику | Открыть окно с графиками |
| Commit Reminder: Быстрые настройки | Поменять настройку через меню |
| Commit Reminder: Открыть все настройки | Открыть настройки плагина |
| Commit Reminder: Отложить напоминания | Отложить на `snoozeMinutes` минут |
| Commit Reminder: Включить / выключить | Включить или выключить напоминания |
| Commit Reminder: Сбросить статистику | Удалить всю статистику |

## Настройки

| Настройка | По умолчанию | Описание |
|---|---|---|
| enabled | true | Включить напоминания |
| intervalMinutes | 30 | Интервал проверки, мин |
| minChangedFiles | 3 | С какого числа файлов напоминать |
| countUntrackedFiles | true | Считать новые файлы |
| message | ... | Текст, можно использовать `{count}` и `{minutes}` |
| notificationType | info | info / warning / error |
| urgentFilesCount | 10 | Больше этого — всегда предупреждение |
| showCommitButton | true | Кнопка «Перейти к коммиту» |
| snoozeMinutes | 15 | На сколько откладывать |
| showStatusBar | true | Счётчик в строке состояния |
| statusBarAlignment | left | left / right |
| statusBarUpdateSeconds | 30 | Частота обновления счётчика |
| remindOnSave | false | Проверять при сохранении файла |
| workingHoursOnly | false | Только в рабочие часы |
| workStartHour | 9 | Начало рабочих часов |
| workEndHour | 21 | Конец рабочих часов |
| ignoreWeekends | false | Не напоминать в выходные |
| collectStatistics | true | Собирать статистику |
| statisticsDays | 7 | Дней на графике |
| chartColorReminders | #e0a030 | Цвет столбиков напоминаний |
| chartColorCommits | #3fa45b | Цвет столбиков коммитов |

## Как запустить

Нужен Node.js 18.19 или новее (проверить: `node -v`).

1. Открыть папку проекта в VS Code.
2. Установить расширение **esbuild Problem Matchers** (connor4312). VS Code сам предложит его при открытии проекта.
3. В терминале (`Terminal → New Terminal`) один раз выполнить `npm install`.
4. Скомпилировать: `npm run compile`. Эта команда проверяет типы TypeScript, проверяет стиль кода (ESLint) и собирает плагин через esbuild в `dist/extension.js`.
5. Нажать `F5` (на Mac `fn + F5` или `Run → Start Debugging`). Откроется второе окно VS Code с плагином («Extension Development Host»).
6. В этом окне открыть любую папку с git-репозиторием и поменять пару файлов.
7. `Ctrl+Shift+P` (на Mac `Cmd+Shift+P`) → «Commit Reminder: Проверить сейчас».

Чтобы быстро проверить напоминания, поставь `intervalMinutes = 1` и `minChangedFiles = 1`.

## Упаковка в .vsix

```bash
npm install -g @vscode/vsce
vsce package
```

Получится файл `commit-reminder-0.0.1.vsix`. Установить его можно так: панель Extensions → `...` → Install from VSIX.

## Структура проекта

Проект создан генератором `yo code` (New Extension (TypeScript), сборщик esbuild).

```
├── .vscode/
│   ├── launch.json       # запуск плагина по F5
│   ├── tasks.json        # перед запуском собирается код (watch)
│   └── extensions.json   # рекомендуемые расширения
├── src/
│   ├── extension.ts      # весь код плагина
│   └── test/             # заготовка тестов от генератора
├── dist/                 # собранный плагин (появляется после компиляции)
├── esbuild.js            # скрипт сборки
├── eslint.config.mjs     # правила проверки стиля кода
├── package.json          # манифест: команды и настройки
├── tsconfig.json         # настройки компилятора TypeScript
├── .vscodeignore         # что не класть в .vsix
├── CHANGELOG.md
├── LICENSE
└── README.md
```

## Как устроено

- `package.json`: описание плагина, команды и все настройки (раздел `contributes.configuration`). По нему VS Code сам строит окно настроек. `activationEvents: onStartupFinished` запускает плагин сразу после загрузки VS Code.
- `src/extension.ts`: весь код плагина на TypeScript.
  - Git вызывается через `child_process.exec` (`git status --porcelain`, `git rev-parse HEAD`).
  - Коммит засчитывается, когда меняется `HEAD`.
  - Статистика хранится в `context.globalState`, поэтому не пропадает после перезапуска VS Code.
  - Графики рисуются в Webview обычными `div`-ами без сторонних библиотек.
