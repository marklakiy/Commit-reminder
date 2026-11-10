// Commit Reminder — плагин для VS Code
// Напоминает сделать коммит, если накопилось много изменённых файлов,
// и собирает статистику (сколько было напоминаний, коммитов и т.д.)

import * as vscode from 'vscode';
import { exec } from 'child_process';

// ---------- Типы данных ----------

// Статистика за один день
interface DayStats {
    reminders: number;     // сколько раз показали напоминание
    commits: number;       // сколько коммитов заметили
    snoozes: number;       // сколько раз нажали «Отложить»
    commitClicks: number;  // сколько раз нажали «Перейти к коммиту»
}

// Вся статистика
interface Stats {
    days: { [date: string]: DayStats };  // ключ — дата "ГГГГ-ММ-ДД"
    commitsByHour: number[];             // 24 числа: коммиты по часам
    maxChangedFiles: number;             // рекорд изменённых файлов
}

// Описание настройки для меню «Быстрые настройки»
interface QuickSetting {
    key: string;
    label: string;
    type: 'boolean' | 'number' | 'string' | 'enum';
    values?: string[];  // варианты, только для enum
}

// ---------- Глобальные переменные ----------

let checkTimer: NodeJS.Timeout | undefined;    // таймер напоминаний
let statusTimer: NodeJS.Timeout | undefined;   // таймер строки состояния
let statusBarItem: vscode.StatusBarItem | undefined;
let snoozeUntil = 0;                // до какого времени напоминания отложены
let lastHead: string | null = null; // последний известный коммит (HEAD)
let lastCommitTime = Date.now();
let lastSaveCheck = 0;              // когда последний раз проверяли при сохранении
let extContext: vscode.ExtensionContext;

// ---------- Вспомогательные функции ----------

function getConfig(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('commitReminder');
}

// Путь к первой открытой папке
function getFolder(): string | null {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        return null;
    }
    return folders[0].uri.fsPath;
}

// Запускает команду git и возвращает её вывод (или null, если ошибка)
function runGit(args: string): Promise<string | null> {
    return new Promise((resolve) => {
        const folder = getFolder();
        if (!folder) {
            resolve(null);
            return;
        }
        exec('git ' + args, { cwd: folder }, (err, stdout) => {
            if (err) {
                resolve(null);
            } else {
                resolve(stdout.trim());
            }
        });
    });
}

// Считает число изменённых файлов. Возвращает -1, если это не git-репозиторий
async function getChangedFilesCount(): Promise<number> {
    const output = await runGit('status --porcelain');
    if (output === null) {
        return -1;
    }
    if (output === '') {
        return 0;
    }
    let lines = output.split('\n');
    if (!getConfig().get<boolean>('countUntrackedFiles')) {
        // строки, начинающиеся с ??, — это новые файлы
        lines = lines.filter(line => !line.startsWith('??'));
    }
    return lines.length;
}

// Дата в виде строки ГГГГ-ММ-ДД
function dateKey(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
}

// ---------- Статистика ----------

function emptyStats(): Stats {
    return {
        days: {},
        commitsByHour: new Array(24).fill(0),
        maxChangedFiles: 0
    };
}

function loadStats(): Stats {
    return extContext.globalState.get<Stats>('stats', emptyStats());
}

function saveStats(stats: Stats): void {
    extContext.globalState.update('stats', stats);
}

// Увеличивает счётчик name за сегодня
function addStat(name: keyof DayStats): void {
    if (!getConfig().get<boolean>('collectStatistics')) {
        return;
    }
    const stats = loadStats();
    const today = dateKey(new Date());
    if (!stats.days[today]) {
        stats.days[today] = { reminders: 0, commits: 0, snoozes: 0, commitClicks: 0 };
    }
    stats.days[today][name]++;
    if (name === 'commits') {
        stats.commitsByHour[new Date().getHours()]++;
    }
    saveStats(stats);
}

function updateMaxChanged(count: number): void {
    if (!getConfig().get<boolean>('collectStatistics')) {
        return;
    }
    const stats = loadStats();
    if (count > stats.maxChangedFiles) {
        stats.maxChangedFiles = count;
        saveStats(stats);
    }
}

// ---------- Проверка, можно ли сейчас напоминать ----------

function isGoodTimeToRemind(): boolean {
    const config = getConfig();
    const now = new Date();

    if (Date.now() < snoozeUntil) {
        return false;
    }
    if (config.get<boolean>('ignoreWeekends')) {
        const day = now.getDay(); // 0 — воскресенье, 6 — суббота
        if (day === 0 || day === 6) {
            return false;
        }
    }
    if (config.get<boolean>('workingHoursOnly')) {
        const hour = now.getHours();
        const start = config.get<number>('workStartHour', 9);
        const end = config.get<number>('workEndHour', 21);
        if (hour < start || hour >= end) {
            return false;
        }
    }
    return true;
}

// ---------- Отслеживание коммитов ----------

async function checkForNewCommit(): Promise<void> {
    const head = await runGit('rev-parse HEAD');
    if (head === null) {
        return;
    }
    if (lastHead !== null && head !== lastHead) {
        // HEAD поменялся — значит, был сделан коммит
        addStat('commits');
        lastCommitTime = Date.now();
    }
    lastHead = head;
}

// ---------- Строка состояния ----------

function createStatusBar(): void {
    if (statusBarItem) {
        statusBarItem.dispose();
        statusBarItem = undefined;
    }
    const config = getConfig();
    if (!config.get<boolean>('showStatusBar')) {
        return;
    }
    const alignment = config.get<string>('statusBarAlignment') === 'right'
        ? vscode.StatusBarAlignment.Right
        : vscode.StatusBarAlignment.Left;
    statusBarItem = vscode.window.createStatusBarItem(alignment, 100);
    statusBarItem.command = 'commitReminder.showStatistics';
    statusBarItem.tooltip = 'Commit Reminder: нажми, чтобы открыть статистику';
    statusBarItem.show();
    updateStatusBar();
}

async function updateStatusBar(): Promise<void> {
    await checkForNewCommit();
    if (!statusBarItem) {
        return;
    }
    const count = await getChangedFilesCount();
    if (count < 0) {
        statusBarItem.text = '$(git-commit) нет git';
        statusBarItem.backgroundColor = undefined;
        return;
    }
    let text = '$(git-commit) ' + count;
    if (!getConfig().get<boolean>('enabled')) {
        text += ' (выкл)';
    } else if (Date.now() < snoozeUntil) {
        text += ' (отложено)';
    }
    statusBarItem.text = text;

    if (count >= getConfig().get<number>('minChangedFiles', 3)) {
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    } else {
        statusBarItem.backgroundColor = undefined;
    }
}

// ---------- Само напоминание ----------

async function checkAndRemind(manual: boolean): Promise<void> {
    const config = getConfig();
    await checkForNewCommit();

    if (!manual) {
        if (!config.get<boolean>('enabled') || !isGoodTimeToRemind()) {
            return;
        }
    }

    const count = await getChangedFilesCount();
    if (count < 0) {
        if (manual) {
            vscode.window.showWarningMessage('Открытая папка не является git-репозиторием.');
        }
        return;
    }
    updateMaxChanged(count);

    if (count < config.get<number>('minChangedFiles', 3)) {
        if (manual) {
            vscode.window.showInformationMessage('Изменённых файлов: ' + count + '. Пока можно не коммитить.');
        }
        return;
    }

    addStat('reminders');

    const minutes = Math.round((Date.now() - lastCommitTime) / 60000);
    const text = config.get<string>('message', '')
        .replace('{count}', String(count))
        .replace('{minutes}', String(minutes));

    const buttons: string[] = [];
    if (config.get<boolean>('showCommitButton')) {
        buttons.push('Перейти к коммиту');
    }
    buttons.push('Отложить');

    let type = config.get<string>('notificationType', 'info');
    if (count > config.get<number>('urgentFilesCount', 10) && type === 'info') {
        type = 'warning';
    }

    let answer: string | undefined;
    if (type === 'error') {
        answer = await vscode.window.showErrorMessage(text, ...buttons);
    } else if (type === 'warning') {
        answer = await vscode.window.showWarningMessage(text, ...buttons);
    } else {
        answer = await vscode.window.showInformationMessage(text, ...buttons);
    }

    if (answer === 'Перейти к коммиту') {
        addStat('commitClicks');
        vscode.commands.executeCommand('workbench.view.scm');
    } else if (answer === 'Отложить') {
        snooze();
    }
}

function snooze(): void {
    const minutes = getConfig().get<number>('snoozeMinutes', 15);
    snoozeUntil = Date.now() + minutes * 60 * 1000;
    addStat('snoozes');
    vscode.window.showInformationMessage('Напоминания отложены на ' + minutes + ' мин.');
    updateStatusBar();
}

// ---------- Таймеры ----------

function startTimers(): void {
    stopTimers();
    const config = getConfig();
    const interval = config.get<number>('intervalMinutes', 30) * 60 * 1000;
    checkTimer = setInterval(() => checkAndRemind(false), interval);

    const statusInterval = config.get<number>('statusBarUpdateSeconds', 30) * 1000;
    statusTimer = setInterval(updateStatusBar, statusInterval);
}

function stopTimers(): void {
    if (checkTimer) {
        clearInterval(checkTimer);
        checkTimer = undefined;
    }
    if (statusTimer) {
        clearInterval(statusTimer);
        statusTimer = undefined;
    }
}

// ---------- Быстрые настройки (через QuickPick) ----------

const quickSettingsList: QuickSetting[] = [
    { key: 'enabled', label: 'Напоминания включены', type: 'boolean' },
    { key: 'intervalMinutes', label: 'Интервал проверки (мин)', type: 'number' },
    { key: 'minChangedFiles', label: 'Минимум изменённых файлов', type: 'number' },
    { key: 'countUntrackedFiles', label: 'Считать новые файлы', type: 'boolean' },
    { key: 'message', label: 'Текст напоминания', type: 'string' },
    { key: 'notificationType', label: 'Вид уведомления', type: 'enum', values: ['info', 'warning', 'error'] },
    { key: 'urgentFilesCount', label: 'Порог «срочного» напоминания', type: 'number' },
    { key: 'showCommitButton', label: 'Кнопка «Перейти к коммиту»', type: 'boolean' },
    { key: 'snoozeMinutes', label: 'Отложить на (мин)', type: 'number' },
    { key: 'showStatusBar', label: 'Показывать в строке состояния', type: 'boolean' },
    { key: 'statusBarAlignment', label: 'Сторона строки состояния', type: 'enum', values: ['left', 'right'] },
    { key: 'statusBarUpdateSeconds', label: 'Обновление строки состояния (сек)', type: 'number' },
    { key: 'remindOnSave', label: 'Проверять при сохранении', type: 'boolean' },
    { key: 'workingHoursOnly', label: 'Только в рабочие часы', type: 'boolean' },
    { key: 'workStartHour', label: 'Начало рабочего дня (час)', type: 'number' },
    { key: 'workEndHour', label: 'Конец рабочего дня (час)', type: 'number' },
    { key: 'ignoreWeekends', label: 'Не напоминать в выходные', type: 'boolean' },
    { key: 'collectStatistics', label: 'Собирать статистику', type: 'boolean' },
    { key: 'statisticsDays', label: 'Дней на графике', type: 'number' },
    { key: 'chartColorReminders', label: 'Цвет «напоминаний» на графике', type: 'string' },
    { key: 'chartColorCommits', label: 'Цвет «коммитов» на графике', type: 'string' }
];

// Пункт списка: обычный QuickPickItem + ссылка на настройку
interface SettingItem extends vscode.QuickPickItem {
    setting: QuickSetting | null;
}

async function showQuickSettings(): Promise<void> {
    const config = getConfig();
    const items: SettingItem[] = quickSettingsList.map(s => ({
        label: s.label,
        description: String(config.get(s.key)),
        setting: s
    }));
    items.push({ label: '$(gear) Открыть все настройки в окне Settings', setting: null });

    const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Выбери настройку, которую хочешь изменить'
    });
    if (!picked) {
        return;
    }
    if (!picked.setting) {
        vscode.commands.executeCommand('commitReminder.openSettings');
        return;
    }

    const s = picked.setting;
    let newValue: boolean | number | string | undefined;

    if (s.type === 'boolean') {
        newValue = !config.get<boolean>(s.key); // просто переключаем
    } else if (s.type === 'enum') {
        newValue = await vscode.window.showQuickPick(s.values ?? [], { placeHolder: s.label });
    } else {
        const input = await vscode.window.showInputBox({
            prompt: s.label,
            value: String(config.get(s.key)),
            validateInput: (text) => {
                if (s.type === 'number' && (text === '' || isNaN(Number(text)))) {
                    return 'Нужно ввести число';
                }
                return null;
            }
        });
        if (input !== undefined) {
            newValue = s.type === 'number' ? Number(input) : input;
        }
    }

    if (newValue === undefined) {
        return;
    }
    await config.update(s.key, newValue, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(s.label + ': ' + newValue);
}

// ---------- Окно статистики ----------

function showStatistics(): void {
    const panel = vscode.window.createWebviewPanel(
        'commitReminderStats',
        'Статистика коммитов',
        vscode.ViewColumn.One,
        {}
    );
    panel.webview.html = getStatsHtml();
}

// Рисует столбчатую диаграмму из div-ов
function makeBarChart(labels: (string | number)[], values: number[], color: string): string {
    const max = Math.max(1, ...values);
    let html = '<div class="chart">';
    for (let i = 0; i < labels.length; i++) {
        const height = Math.round(values[i] / max * 150);
        html += '<div class="col">'
            + '<div class="value">' + values[i] + '</div>'
            + '<div class="bar" style="height:' + height + 'px; background:' + color + '"></div>'
            + '<div class="label">' + labels[i] + '</div>'
            + '</div>';
    }
    html += '</div>';
    return html;
}

function getStatsHtml(): string {
    const config = getConfig();
    const stats = loadStats();
    const daysCount = config.get<number>('statisticsDays', 7);
    const colorReminders = config.get<string>('chartColorReminders', '#e0a030');
    const colorCommits = config.get<string>('chartColorCommits', '#3fa45b');

    // Данные за последние N дней
    const labels: string[] = [];
    const reminders: number[] = [];
    const commits: number[] = [];
    for (let i = daysCount - 1; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = dateKey(d);
        const day = stats.days[key];
        labels.push(key.slice(5)); // ММ-ДД
        reminders.push(day ? day.reminders : 0);
        commits.push(day ? day.commits : 0);
    }

    // Итоги за всё время
    let totalReminders = 0, totalCommits = 0, totalSnoozes = 0, totalClicks = 0;
    for (const key in stats.days) {
        totalReminders += stats.days[key].reminders || 0;
        totalCommits += stats.days[key].commits || 0;
        totalSnoozes += stats.days[key].snoozes || 0;
        totalClicks += stats.days[key].commitClicks || 0;
    }
    const activeDays = Object.keys(stats.days).length;
    const avgCommits = activeDays > 0 ? (totalCommits / activeDays).toFixed(1) : '0';
    const reaction = totalReminders > 0 ? Math.round(totalClicks / totalReminders * 100) : 0;

    const hours: number[] = [];
    for (let h = 0; h < 24; h++) {
        hours.push(h);
    }

    return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<style>
    body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 20px; }
    h1 { font-size: 22px; }
    h2 { font-size: 17px; margin-top: 30px; }
    table { border-collapse: collapse; }
    td { padding: 4px 16px 4px 0; }
    td.num { font-weight: bold; }
    .chart { display: flex; align-items: flex-end; gap: 6px; height: 200px;
             border-bottom: 1px solid var(--vscode-foreground); padding-bottom: 4px; }
    .col { display: flex; flex-direction: column; align-items: center; min-width: 24px; }
    .bar { width: 20px; border-radius: 3px 3px 0 0; }
    .value { font-size: 11px; }
    .label { font-size: 10px; margin-top: 4px; }
    .legend span { display: inline-block; width: 12px; height: 12px; margin-right: 4px; }
    .note { opacity: 0.7; font-size: 12px; }
</style>
</head>
<body>
    <h1>Статистика Commit Reminder</h1>

    <table>
        <tr><td>Всего напоминаний:</td><td class="num">${totalReminders}</td></tr>
        <tr><td>Всего коммитов (замечено плагином):</td><td class="num">${totalCommits}</td></tr>
        <tr><td>Отложено напоминаний:</td><td class="num">${totalSnoozes}</td></tr>
        <tr><td>Нажато «Перейти к коммиту»:</td><td class="num">${totalClicks} (${reaction}% от напоминаний)</td></tr>
        <tr><td>Среднее число коммитов в день:</td><td class="num">${avgCommits}</td></tr>
        <tr><td>Рекорд незакоммиченных файлов:</td><td class="num">${stats.maxChangedFiles}</td></tr>
    </table>

    <h2>Напоминания за последние ${daysCount} дн.</h2>
    <div class="legend"><span style="background:${colorReminders}"></span>напоминания</div>
    ${makeBarChart(labels, reminders, colorReminders)}

    <h2>Коммиты за последние ${daysCount} дн.</h2>
    <div class="legend"><span style="background:${colorCommits}"></span>коммиты</div>
    ${makeBarChart(labels, commits, colorCommits)}

    <h2>В какие часы ты коммитишь</h2>
    ${makeBarChart(hours, stats.commitsByHour, colorCommits)}

    <p class="note">Коммиты считаются, только пока VS Code открыт и плагин работает.
    Количество дней и цвета графиков меняются в настройках.</p>
</body>
</html>`;
}

// ---------- Активация плагина ----------

// Вызывается, когда VS Code запускает плагин
export function activate(context: vscode.ExtensionContext): void {
    extContext = context;
    console.log('Плагин "commit-reminder" активирован');

    // Регистрируем команды из package.json
    context.subscriptions.push(
        vscode.commands.registerCommand('commitReminder.checkNow', () => checkAndRemind(true)),
        vscode.commands.registerCommand('commitReminder.showStatistics', showStatistics),
        vscode.commands.registerCommand('commitReminder.quickSettings', showQuickSettings),
        vscode.commands.registerCommand('commitReminder.openSettings', () => {
            vscode.commands.executeCommand('workbench.action.openSettings', 'commitReminder');
        }),
        vscode.commands.registerCommand('commitReminder.snooze', snooze),
        vscode.commands.registerCommand('commitReminder.toggle', async () => {
            const config = getConfig();
            const newValue = !config.get<boolean>('enabled');
            await config.update('enabled', newValue, vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage('Commit Reminder ' + (newValue ? 'включён' : 'выключен'));
        }),
        vscode.commands.registerCommand('commitReminder.resetStatistics', async () => {
            const answer = await vscode.window.showWarningMessage(
                'Точно сбросить всю статистику?', { modal: true }, 'Да');
            if (answer === 'Да') {
                saveStats(emptyStats());
                vscode.window.showInformationMessage('Статистика сброшена.');
            }
        })
    );

    // Проверка при сохранении файла
    context.subscriptions.push(
        vscode.workspace.onDidSaveTextDocument(() => {
            updateStatusBar();
            // не чаще одного раза в 2 минуты, чтобы не надоедать
            if (getConfig().get<boolean>('remindOnSave') && Date.now() - lastSaveCheck > 2 * 60 * 1000) {
                lastSaveCheck = Date.now();
                checkAndRemind(false);
            }
        })
    );

    // Если пользователь поменял настройки — перезапускаем всё
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration('commitReminder')) {
                createStatusBar();
                startTimers();
            }
        })
    );

    createStatusBar();
    startTimers();
    checkForNewCommit();
}

// Вызывается при выключении плагина
export function deactivate(): void {
    stopTimers();
    if (statusBarItem) {
        statusBarItem.dispose();
    }
    console.log('Плагин "commit-reminder" деактивирован');
}
