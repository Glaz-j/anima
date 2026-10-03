import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { getExamTask, STAGE_ONE_TASKS } from './tasks.ts';
import { SkillExamReferee } from './referee.ts';
import { measureExam } from './metrics.ts';
import type { ExamAdapter, ExamArchitecture, ExamCandidateMetadata, ExamEvent, ExamExecutor, ExamResult, ExamSourceIdentity, ExamTask, ServerEvidence } from './types.ts';

export class UnsupportedExam extends Error { code = 'UNSUPPORTED'; }
/** Capture before loading the candidate; results contain only identity/hash, never a diff or credential. */
export async function captureExamSource(root: string): Promise<ExamSourceIdentity> {
  const capturedAt = new Date().toISOString(), run = promisify(execFile);
  const git = async (args: string[]) => (await run('git', args, { cwd: root, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })).stdout;
  try {
    const [head, status, diff, untracked] = await Promise.all([
      git(['rev-parse', 'HEAD']), git(['status', '--porcelain=v1', '-z']), git(['diff', '--binary', 'HEAD']), git(['ls-files', '--others', '--exclude-standard', '-z']),
    ]);
    const hash = createHash('sha256').update(head.trim()).update('\0').update(diff);
    for (const path of untracked.split('\0').filter(path => /\.(?:ts|js|mjs|cjs|json|md)$/iu.test(path)).sort()) hash.update('\0' + path).update(await readFile(join(root, path)));
    return { gitHead: head.trim(), dirty: Boolean(status), workingTreeId: hash.digest('hex').slice(0, 16), capturedAt };
  } catch { return { gitHead: null, dirty: null, workingTreeId: 'unavailable', capturedAt }; }
}
export function safeCandidateMetadata(value?: ExamCandidateMetadata): ExamCandidateMetadata {
  const text = (value: unknown) => typeof value === 'string' && value.length <= 160 && !/[\r\n\0]/u.test(value) ? value : undefined;
  const id = text(value?.model?.id), provider = text(value?.model?.provider), controller = text(value?.controller);
  return { ...(id ? { model: { id, ...(provider ? { provider } : {}) } } : {}), ...(controller ? { controller } : {}) };
}
async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { onTimeout?.(); reject(new Error(message)); }, milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}
export async function runSkillExam(options: {
  taskId: string; adapter: ExamAdapter; executor: ExamExecutor; actor: string;
  outputDirectory?: string; mode?: 'skill' | 'agent'; modelDelayMs?: number;
  architecture?: ExamArchitecture; candidate?: ExamCandidateMetadata; source?: ExamSourceIdentity;
  signal?: AbortSignal; pollMs?: number;
  /** Test/variant injection; included revision and id remain visible in results. */
  task?: ExamTask;
}): Promise<ExamResult> {
  if (!/^[A-Za-z0-9_]{1,16}$/u.test(options.actor)) throw new Error('Invalid exam actor name.');
  const architecture = options.architecture || 'dual';
  if (!['serial', 'parallel', 'dual'].includes(architecture)) throw new Error('Invalid exam architecture.');
  const task = options.task || getExamTask(options.taskId), adapter = options.adapter;
  if (task.id !== options.taskId) throw new Error('Task identity mismatch.');
  const controller = new AbortController();
  const abort = () => controller.abort(options.signal?.reason || new Error('Exam cancelled.'));
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  const runId = `exam-${randomUUID()}`, startedAt = new Date().toISOString();
  const events: ExamEvent[] = []; let initial: ServerEvidence | undefined, final: ServerEvidence | undefined;
  let referee: SkillExamReferee | undefined, handle: Awaited<ReturnType<ExamExecutor['start']>> | undefined;
  let status: ExamResult['status'] = 'failed', reason = 'Time limit exceeded.', accepting = true;
  let executorFault: string | undefined;
  let writes: Promise<unknown> = Promise.resolve(), writeError: unknown;
  const directory = options.outputDirectory ? join(options.outputDirectory, runId) : undefined;
  const persist = (kind: string, value: unknown) => {
    if (!directory) return;
    writes = writes.then(() => appendFile(join(directory, `${kind}.jsonl`), JSON.stringify(value) + '\n')).catch(error => { writeError ||= error; });
  };
  const emit = (event: ExamEvent) => {
    if (!accepting) return;
    if (events.length >= 200_000) { controller.abort(new Error('Telemetry limit exceeded.')); return; }
    events.push(structuredClone(event)); persist('events', event);
  };
  const fail = (summary: string) => {
    if (!accepting || executorFault) return;
    executorFault = typeof summary === 'string' ? summary.replace(/Bearer\s+\S+/giu, 'Bearer [redacted]').replace(/((?:api[_-]?key|token|password)[=:]\s*)[^\s&]+/giu, '$1[redacted]').replace(/[\r\n]/gu, ' ').slice(0, 300) : 'Executor reported an infrastructure fault.';
    emit({ type: 'note', at: Date.now(), message: `Executor infrastructure fault: ${executorFault}` });
    controller.abort(new Error(executorFault));
  };
  try {
    if (directory) {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'task.json'), JSON.stringify(task, null, 2) + '\n');
    }
    const missing = task.required.filter(capability => !adapter.capabilities.has(capability));
    if (missing.length) throw new UnsupportedExam(`Adapter lacks ${missing.join(', ')}.`);
    controller.signal.throwIfAborted();
    initial = final = await adapter.prepare(task, options.actor, controller.signal);
    if (adapter.mode === 'real-server' && initial.source !== 'vanilla-rcon') throw new Error('Real scores require authoritative server evidence.');
    referee = new SkillExamReferee(task, initial); persist('evidence', initial);
    // Goal startup must be asynchronous; a blocking start recreates the original architecture fault.
    const dispatch = options.executor.start({
      taskId: task.id, category: (options.mode || 'skill') === 'skill' ? task.category : undefined,
      actor: options.actor, instruction: task.instruction, mode: options.mode || 'skill', architecture, modelDelayMs: options.modelDelayMs || 0,
      signal: controller.signal, emit, fail,
    });
    void dispatch.then(async lateHandle => { if (controller.signal.aborted && !handle) await lateHandle.stop(); }).catch(() => {});
    handle = await withTimeout(dispatch, 3000, 'Executor start did not return within 3 seconds.', () => controller.abort());
    controller.signal.throwIfAborted();
    const deadline = initial.sampledAt + task.timeoutMs;
    while (Date.now() < deadline) {
      controller.signal.throwIfAborted();
      const before = Date.now();
      final = await adapter.sample(controller.signal); persist('evidence', final);
      if (final.sampledAt > deadline) break;
      const verdict = referee.update(final);
      const metrics = measureExam(events, initial, final);
      if (metrics.elapsedMs >= 5000 && metrics.realtimeRatio < 0.65) throw new Error('Server clock is paused or too slow for a valid real-time trial.');
      if (verdict.status !== 'running') { status = verdict.status; reason = verdict.reason; break; }
      if (referee.perturbationReady(final)) {
        if (!adapter.inject) throw new UnsupportedExam('Adapter cannot inject the task perturbation.');
        await adapter.inject(task, final, controller.signal); referee.injected(Date.now());
        persist('referee', { at: Date.now(), type: 'perturbation-injected' });
      }
      const remaining = Math.min(deadline - Date.now(), Math.max(0, (options.pollMs ?? 200) - (Date.now() - before)));
      if (remaining > 0) await delay(remaining, undefined, { signal: controller.signal });
    }
  } catch (error: any) {
    status = options.signal?.aborted ? 'cancelled' : executorFault ? 'infra-error' : error?.code === 'UNSUPPORTED' ? 'unsupported' : 'infra-error';
    reason = executorFault || String(error?.message || error);
  } finally {
    accepting = false; controller.abort(new Error('Exam ended.'));
    try { if (handle) await withTimeout(handle.stop(), 5000, 'Stop acknowledgement timed out.'); } catch (error: any) { reason += `; Executor failed to stop: ${error?.message || error}`; status = 'infra-error'; }
    try { await adapter.cleanup(); } catch (error: any) { reason += `; Arena cleanup failed: ${error?.message || error}`; status = 'infra-error'; }
    options.signal?.removeEventListener('abort', abort);
    await writes;
    if (writeError) { status = 'infra-error'; reason += '; Evidence could not be persisted.'; }
  }
  const result: ExamResult = {
    schemaVersion: 2, runId, taskId: task.id, taskRevision: task.revision, stage: task.stage,
    actor: options.actor, mode: options.mode || 'skill', execution: adapter.mode,
    realScore: adapter.mode === 'real-server' && (status === 'passed' || status === 'failed'),
    status, reason, startedAt, modelDelayMs: options.modelDelayMs || 0,
    metrics: measureExam(events, initial, final), checkpointsReached: referee?.checkpointsReached || 0,
    evidenceCount: referee?.evidenceCount || 0, perturbationInjected: referee?.injectedAt !== undefined,
    architecture, candidate: safeCandidateMetadata(options.candidate), source: options.source || { gitHead: null, dirty: null, workingTreeId: 'unavailable', capturedAt: startedAt },
  };
  if (directory) await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

export function summarizeExams(results: readonly ExamResult[]) {
  const unique = [...new Map(results.map(result => [result.runId, result])).values()];
  const real = unique.filter(result => result.realScore), excluded = unique.filter(result => !result.realScore);
  const grouped = new Map<string, ExamResult[]>();
  for (const result of real) {
    const key = JSON.stringify([result.mode, result.architecture || 'unattributed', result.modelDelayMs,
      safeCandidateMetadata(result.candidate), result.source?.gitHead || null, result.source?.workingTreeId || 'unattributed']);
    const group = grouped.get(key) || []; group.push(result); grouped.set(key, group);
  }
  const groups = [...grouped.values()].map(trials => {
    const first = trials[0], attributionKnown = Boolean(first.architecture && first.source?.gitHead && first.source.workingTreeId !== 'unavailable' && (first.mode === 'skill' || first.candidate?.model?.id));
    const phaseOnePassed = attributionKnown && getPhaseOneGate(trials);
    return {
      mode: first.mode, architecture: first.architecture || 'unattributed', candidate: safeCandidateMetadata(first.candidate),
      source: first.source, modelDelayMs: first.modelDelayMs, validTrials: trials.length,
      passed: trials.filter(result => result.status === 'passed').length,
      successRate: trials.filter(result => result.status === 'passed').length / trials.length,
      attributionKnown, phaseOnePassed, phaseTwoEligible: first.mode === 'agent' && phaseOnePassed,
      tasks: [...new Set(trials.map(result => `${result.taskId}@${result.taskRevision}`))].map(key => {
        const rows = trials.filter(result => `${result.taskId}@${result.taskRevision}` === key);
        return { taskId: rows[0].taskId, revision: rows[0].taskRevision, trials: rows.length, passed: rows.filter(result => result.status === 'passed').length };
      }),
    };
  });
  return {
    validTrials: real.length, passed: real.filter(result => result.status === 'passed').length,
    successRate: real.length ? real.filter(result => result.status === 'passed').length / real.length : null,
    excluded: Object.fromEntries(['unsupported', 'infra-error', 'cancelled', 'fixture'].map(status => [status,
      excluded.filter(result => status === 'fixture' ? result.execution === 'fixture' : result.execution !== 'fixture' && result.status === status).length])),
    groups,
    // The default architecture's agent gate cannot be satisfied by skill-only or other-architecture trials.
    phaseTwoEligible: groups.some(group => group.mode === 'agent' && group.architecture === 'dual' && group.phaseTwoEligible),
  };
}

function getPhaseOneGate(real: readonly ExamResult[]) {
  return STAGE_ONE_TASKS.every(task => {
    const trials = real.filter(result => result.taskId === task.id && result.taskRevision === task.revision && result.modelDelayMs === 0);
    return trials.length >= 5 && trials.every(result => !result.metrics.uninstrumented) && trials.filter(result => result.status === 'passed').length / trials.length >= 0.8;
  });
}
