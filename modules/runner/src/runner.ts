import debug from 'debug';
import got from 'got';
import which from 'which';
import { Operation as PatchOp } from 'fast-json-patch';
import { URL } from 'url';
import { inspect } from 'util';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';

import {
  AnyJob,
  BisectRange,
  Current,
  JobId,
  Platform,
  Result,
  RunnerId,
} from '@electron/bugbot-shared/lib/interfaces';
import { env, envInt } from '@electron/bugbot-shared/lib/env-vars';

import { parseFiddleBisectOutput } from './fiddle-bisect-parser';

const d = debug('runner');

export class Runner {
  public readonly platform: Platform;
  public readonly uuid: RunnerId;

  private readonly brokerUrl: string;
  private readonly childTimeoutMs: number;
  private readonly fiddleExec: string;
  private readonly pollIntervalMs: number;
  private etag: string;
  private interval: ReturnType<typeof setInterval>;
  private jobId: JobId;
  private timeBegun: number;

  /**
   * Creates and initializes the runner from environment variables and default
   * values, then starts the runner's execution loop.
   */
  constructor(
    opts: {
      brokerUrl?: string;
      childTimeoutMs?: number;
      fiddleExec?: string;
      platform?: Platform;
      pollIntervalMs?: number;
      uuid?: string;
    } = {},
  ) {
    this.brokerUrl = opts.brokerUrl || env('BUGBOT_BROKER_URL');
    this.childTimeoutMs =
      opts.childTimeoutMs || envInt('BUGBOT_CHILD_TIMEOUT_MS', 5 * 60_000);
    this.fiddleExec =
      opts.fiddleExec ||
      process.env.BUGBOT_FIDDLE_EXEC ||
      which.sync('electron-fiddle');
    this.platform = (opts.platform || process.platform) as Platform;
    this.pollIntervalMs =
      opts.pollIntervalMs || envInt('BUGBOT_POLL_INTERVAL_MS', 20_000);
    this.uuid = opts.uuid || uuidv4();
  }

  public start(): void {
    this.stop();
    d('runner:start', `interval is ${this.pollIntervalMs}`);
    this.interval = setInterval(
      this.pollSafely.bind(this),
      this.pollIntervalMs,
    );
    this.pollSafely();
  }

  public stop(): void {
    clearInterval(this.interval);
    this.interval = undefined;
    d('runner:stop', 'interval cleared');
  }

  public pollSafely(): void {
    this.poll().catch((err) => d('error while polling broker:', inspect(err)));
  }

  public async poll(): Promise<void> {
    // find the first available job
    const jobId = (await this.fetchAvailableJobs()).shift();
    if (!jobId) {
      return;
    }

    // TODO(clavin): would adding jitter (e.g. claim first OR second randomly)
    // help reduce any possible contention?
    const [job, initialEtag] = await this.fetchJobAndEtag(jobId);
    this.etag = initialEtag;
    this.jobId = job.id;
    this.timeBegun = Date.now();

    // Claim the job
    const current: Current = {
      runner: this.uuid,
      time_begun: this.timeBegun,
    };
    await this.patchJob([{ op: 'replace', path: '/current', value: current }]);

    switch (job.type) {
      case 'bisect':
        await this.runBisect(job.bisect_range, job.gist);
        break;
      default:
        d('unexpected job $O', job);
        break;
    }

    // cleanup
    delete this.etag;
    delete this.jobId;
    delete this.timeBegun;
    d('runner:poll done');
  }

  /**
   * Polls the broker for a list of unclaimed job IDs.
   */
  private async fetchAvailableJobs(): Promise<JobId[]> {
    // Craft the url to the broker
    const jobs_url = new URL('api/jobs', this.brokerUrl);
    // find jobs compatible with this runner...
    jobs_url.searchParams.append('platform', `${this.platform},undefined`);
    // ...is not currently claimed
    jobs_url.searchParams.append('current.runner', 'undefined');
    // ...and which have never been run
    jobs_url.searchParams.append('last.status', 'undefined');
    // FIXME: currently only support bisect but we should support others too
    jobs_url.searchParams.append('type', 'bisect');

    // Make the request and return its response
    return await got(jobs_url).json();
  }

  private async fetchJobAndEtag(id: string): Promise<[AnyJob, string]> {
    const job_url = new URL(`api/jobs/${id}`, this.brokerUrl);
    const resp = await got(job_url);

    // Extract the etag header & make sure it was defined
    const { etag } = resp.headers;
    if (!etag) {
      throw new Error('missing etag in broker job response');
    }

    return [JSON.parse(resp.body), etag];
  }

  private async patchJob(patches: Readonly<PatchOp>[]): Promise<void> {
    d('patches: %O', patches);

    // Send the patch
    const job_url = new URL(`api/jobs/${this.jobId}`, this.brokerUrl);
    const resp = await got(job_url, {
      headers: { etag: this.etag },
      json: patches,
      method: 'PATCH',
    });

    // Extract the etag header & make sure it was defined
    const { etag } = resp.headers;
    if (!etag) {
      throw new Error('missing etag in broker job response');
    }

    this.etag = etag;
  }

  private async putLog(data: any) {
    const body = data.toString();
    d('appendLog', body);
    const log_url = new URL(`api/jobs/${this.jobId}/log`, this.brokerUrl);
    const resp = await got(log_url, {
      body,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
      },
      method: 'PUT',
    });
    d(`appendLog resp.status ${resp.statusCode}`);
  }

  private patchResult(result: Partial<Result>): Promise<void> {
    const defaults: Result = {
      runner: this.uuid,
      status: 'system_error',
      time_begun: this.timeBegun,
      time_ended: Date.now(),
    };
    result = Object.assign(defaults, result);
    return this.patchJob([
      { op: 'add', path: '/history/-', value: result },
      { op: 'replace', path: '/last', value: result },
      { op: 'remove', path: '/current' },
    ]);
  }

  private runBisect(range: BisectRange, gistId: string): Promise<void> {
    const putLog = this.putLog.bind(this);
    const patchResult = this.patchResult.bind(this);
    const { childTimeoutMs, fiddleExec } = this;

    return new Promise<void>((resolve) => {
      const args = ['bisect', range[0], range[1], '--fiddle', gistId];
      const opts = { timeout: childTimeoutMs };
      const child = spawn(fiddleExec, args, opts);

      const prefix = `[${new Date().toLocaleTimeString()}] Runner:`;
      putLog(
        [
          `${prefix} runner id '${this.uuid}' (platform: '${this.platform}')`,
          `${prefix} spawning '${fiddleExec}' ${args.join(' ')}`,
          `${prefix}   ... with opts ${inspect(opts)}`,
        ].join('\n'),
      );

      // TODO(any): could debounce/buffer this data before calling putLog()
      const stdout: any[] = [];
      child.stderr.on('data', (data) => putLog(data));
      child.stdout.on('data', (data) => putLog(data));
      child.stdout.on('data', (data) => stdout.push(data));
      child.on('error', (err) => {
        patchResult({
          error: err.toString(),
          status: 'system_error',
        });
      });
      child.on('close', (exitCode) => {
        const result: Partial<Result> = {};
        try {
          const output = stdout.map((buf) => buf.toString()).join('');
          const res = parseFiddleBisectOutput(output);
          if (res.success) {
            result.status = 'success';
            result.bisect_range = [res.goodVersion, res.badVersion];
          } else {
            // TODO(clavin): ^ better wording
            result.error = 'Failed to narrow test down to two versions';
            result.status = exitCode === 1 ? 'test_error' : 'system_error';
          }
        } catch (parseErr) {
          d('fiddle bisect parse error: %O', parseErr);
          result.status = 'system_error';
          result.error = parseErr.toString();
        } finally {
          patchResult(result).then(() => resolve());
        }
      });
    });
  }
}
