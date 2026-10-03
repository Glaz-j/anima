import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { prepareExamServer, loadExamServer } from './server.ts';
import { VanillaExamAdapter } from './adapter.ts';
import { STAGE_ONE_TASKS, STAGE_TWO_PLAN } from './tasks.ts';
import { captureExamSource, runSkillExam, summarizeExams } from './runner.ts';
import type { ExamArchitecture, ExamCandidateMetadata, ExamExecutor, ExamResult } from './types.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2), command = args[0] || 'list';
const option = (name: string, fallback?: string) => { const at = args.indexOf(`--${name}`); if (at === -1) return fallback; if (!args[at + 1] || args[at + 1].startsWith('--')) throw new Error(`Missing --${name} value.`); return args[at + 1]; };
const output = join(root, 'var/minecraft/skill-exam/results');
if (command === 'list') {
  console.log(JSON.stringify({ stageOne: STAGE_ONE_TASKS.map(({ id, title, category, timeoutMs }) => ({ id, title, category, timeoutMs })), stageTwo: STAGE_TWO_PLAN }, null, 2));
} else if (command === 'prepare') {
  const config = await prepareExamServer(root);
  console.log(JSON.stringify({ prepared: true, started: false, directory: config.directory, gamePort: config.gamePort, rconPort: config.rconPort }, null, 2));
} else if (command === 'serve') {
  const config = await loadExamServer(root);
  const child = spawn(config.java, ['-Xms256M', '-Xmx1G', '-jar', config.serverJar, 'nogui'], { cwd: config.directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  const logPath = join(config.directory, 'exam-console.log'); let logs: Promise<unknown> = Promise.resolve();
  const record = (chunk: Buffer) => { const text = chunk.toString(); process.stdout.write(text); logs = logs.then(() => appendFile(logPath, text)).catch(() => {}); };
  child.stdout!.on('data', record); child.stderr!.on('data', record);
  await writeFile(join(config.directory, 'process.json'), JSON.stringify({ ownerPid: process.pid, javaPid: child.pid, startedAt: new Date().toISOString(), port: config.gamePort }, null, 2) + '\n');
  const stop = () => { child.stdin?.write('stop\n'); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  const code = await new Promise<number | null>(resolve => child.once('exit', resolve)); await logs;
  process.exitCode = code ?? 1;
} else if (command === 'run') {
  const config = await loadExamServer(root), actor = option('actor', 'ExamBot')!;
  const architecture = option('architecture', 'dual') as ExamArchitecture;
  if (!['serial', 'parallel', 'dual'].includes(architecture)) throw new Error('Architecture must be serial, parallel, or dual.');
  const ids = option('task', 'gather-01') === 'all' ? STAGE_ONE_TASKS.map(task => task.id) : option('task', 'gather-01')!.split(',');
  const mode = option('mode', 'skill'), repetitions = Number(option('repeat', '1')), modelDelayMs = Number(option('model-delay-ms', option('delay', '0')));
  if (mode !== 'skill' && mode !== 'agent') throw new Error('Mode must be skill or agent.');
  if (mode === 'skill' && architecture !== 'dual') throw new Error('Skill mode qualifies the shared executor using dual policies; architecture comparisons require --mode agent.');
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 100 || !Number.isInteger(modelDelayMs) || modelDelayMs < 0 || modelDelayMs > 60_000) throw new Error('Invalid repeat or model delay.');
  const source = await captureExamSource(root);
  const modulePath = resolve(root, option('executor', 'adapters/minecraft/benchmark/body-executor.ts')!);
  const module = await import(pathToFileURL(modulePath).href);
  if (typeof module.createExamExecutor !== 'function') throw new Error('Executor module must export createExamExecutor().');
  const controller = new AbortController(); process.once('SIGINT', () => controller.abort(new Error('Interrupted.')));
  const adapter = new VanillaExamAdapter(config), results: ExamResult[] = [];
  try {
    for (let repetition = 0; repetition < repetitions && !controller.signal.aborted; repetition += 1) {
      for (const taskId of ids) {
        // Fresh controller, model context and private memory for EVERY trial.
        // Reusing a stopped body changes its initial emergency authorization.
        // Candidate only receives public connection data, never the RCON secret.
        const integration: { executor: ExamExecutor; metadata?: ExamCandidateMetadata; close?(): Promise<void> } = await module.createExamExecutor({ root, host: '127.0.0.1', port: config.gamePort, version: config.version, actor, architecture, mode });
        let result: ExamResult;
        try {
          if (!integration?.executor?.start) throw new Error('Invalid executor module.');
          result = await runSkillExam({ taskId, actor, adapter, executor: integration.executor, mode, architecture, candidate: integration.metadata, source, modelDelayMs, outputDirectory: output, signal: controller.signal });
        } finally { await integration.close?.(); }
        results.push(result); console.log(JSON.stringify(result));
        // Do not reuse a body whose stop/connection may be broken. The run remains reviewable.
        if (result.status === 'infra-error' || result.status === 'cancelled') { controller.abort(); break; }
      }
    }
    await mkdir(output, { recursive: true });
    const summary = summarizeExams(results); console.log(JSON.stringify(summary, null, 2));
    process.exitCode = results.length && results.every(result => result.status === 'passed') ? 0 : 1;
  } finally { adapter.close(); }
} else if (command === 'report') {
  const results: ExamResult[] = [];
  for (const entry of await readdir(output, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory() || !entry.name.startsWith('exam-')) continue;
    try { results.push(JSON.parse(await readFile(join(output, entry.name, 'result.json'), 'utf8'))); } catch { /* Incomplete runs are not fabricated results. */ }
  }
  const filtered = results.filter(result => (!option('mode') || result.mode === option('mode')) && (!option('architecture') || result.architecture === option('architecture')));
  console.log(JSON.stringify({ summary: summarizeExams(filtered), trials: filtered.map(({ runId, taskId, taskRevision, mode, architecture, candidate, source, modelDelayMs, status, reason, realScore, metrics }) => ({ runId, taskId, taskRevision, mode, architecture, candidate, source, modelDelayMs, status, reason, realScore, metrics })) }, null, 2));
} else throw new Error('Commands: list, prepare, serve, run, report.');
