import { EventEmitter } from 'events';
import path from 'path';
import type { ConsoleMessage, Viewport } from 'puppeteer-core';
import {
  Story,
  StorybookConnection,
  StoryPreviewBrowser,
  MetricsWatcher,
  ResourceWatcher,
  sleep,
  getDeviceDescriptors,
} from '@prantlf/storycrawler';

import { MainOptions, RunMode } from './types.js';
import { VariantKey, ScreenshotOptions, StrictScreenshotOptions, Exposed } from '../shared/types.js';
import { ScreenshotTimeoutError, InvalidCurrentStoryStateError } from './errors.js';
import {
  createBaseScreenshotOptions,
  mergeScreenshotOptions,
  extractVariantKeys,
  pickupWithVariantKey,
  InvalidVariantKeysReason,
} from '../shared/screenshot-options-helper.js';
import { Logger } from './logger.js';
import { FileSystem } from './file.js';
import { isRecoverableNavigationContextError } from './recoverable-error.js';
import { areLastBuffersEqual } from './stable-screenshot.js';

type ScreenshotArgs = {
  fullPage?: boolean;
  omitBackground?: boolean;
  captureBeyondViewport?: boolean;
  clip?: { x: number; y: number; width: number; height: number };
};

/**
 *
 * Represents screenshot result.
 *
 * @remarks
 *
 * - If user's screenshot option has `skip: true`,`buffer` gets null and `succeeded` gets `true`
 * - `variantKeysToPush` is set an empty array if the capturing process is set not default variant key. It makes sense for only default variant.
 * - `defaultVariantSuffix` makes sense for only default variant too. It's set non-null value when user specifies multiple viewports.
 * - `storyError` is set if Storybook rendered its error display instead of the story. `buffer` gets null if `failOnStoryError` is enabled.
 *
 **/
interface ScreenshotResult {
  buffer: Buffer | null;
  succeeded: boolean;
  variantKeysToPush: VariantKey[];
  defaultVariantSuffix?: string;
  storyError?: StoryErrorInfo;
}

/**
 *
 * Error shown by Storybook's error display when a story failed to render.
 *
 **/
export interface StoryErrorInfo {
  message: string;
  stack: string;
}

/**
 *
 * Runs in the page and records render errors reported on Storybook's channel in `window.__storycapStoryError`.
 *
 * Attaches to the channel right away if it exists, otherwise as soon as Storybook's builder assigns
 * `window.__STORYBOOK_ADDONS_CHANNEL__`. That makes it work as an `evaluateOnNewDocument` script, which keeps
 * watching after the page reloads, e.g. when the viewport changes to a mobile one.
 *
 **/
function watchStoryErrorsInPage() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const attach = (channel: any) => {
    if (!channel || w.__storycapWatchesStoryErrors) return;
    w.__storycapWatchesStoryErrors = true;
    channel.on('storyThrewException', (error: { message?: string; stack?: string }) => {
      w.__storycapStoryError = { message: error?.message || 'Unknown error', stack: error?.stack || '' };
    });
    channel.on('storyErrored', (error: { title?: string; description?: string }) => {
      w.__storycapStoryError = { message: error?.title || 'Unknown error', stack: error?.description || '' };
    });
  };
  if (w.__STORYBOOK_ADDONS_CHANNEL__) {
    attach(w.__STORYBOOK_ADDONS_CHANNEL__);
    return;
  }
  let channel: unknown;
  Object.defineProperty(w, '__STORYBOOK_ADDONS_CHANNEL__', {
    configurable: true,
    enumerable: true,
    get: () => channel,
    set: value => {
      channel = value;
      attach(value);
    },
  });
}

/**
 *
 * A worker to capture screenshot images.
 *
 **/
export class CapturingBrowser extends StoryPreviewBrowser {
  private currentStoryRetryCount = 0;
  private viewport?: Viewport;
  private emitter: EventEmitter;
  private readonly processedStories = new Set<string>();
  private baseScreenshotOptions: StrictScreenshotOptions;
  private currentRequestId!: string;
  private currentVariantKey: VariantKey = { isDefault: true, keys: [] };
  private touched = false;
  private resourceWatcher!: ResourceWatcher;
  private readonly interactionSelectorWaitTimeout = 1500;

  /**
   *
   * @override
   *
   * @param opt - Options for Storycap.
   * @param mode - Indicates this worker runs as managed mode or simple mode.
   * @param idx - Worker id.
   *
   **/
  constructor(
    protected connection: StorybookConnection,
    protected opt: MainOptions,
    private mode: RunMode,
    idx: number,
  ) {
    super(connection, idx, opt, opt.logger);
    this.emitter = new EventEmitter();
    this.emitter.on('error', e => {
      throw e;
    });
    this.baseScreenshotOptions = createBaseScreenshotOptions(opt);
  }

  /**
   *
   * @override
   *
   **/
  async boot() {
    await super.boot();
    // The preview is already loaded at this point, so watch it now and in every document loaded later.
    await this.page.evaluateOnNewDocument(watchStoryErrorsInPage);
    await this.page.evaluate(watchStoryErrorsInPage);
    await this.expose();
    await this.addStyles();
    this.resourceWatcher = new ResourceWatcher(this.page).init();
    return this;
  }

  private async addStyles() {
    if (this.opt.disableCssAnimation) {
      await this.page.addStyleTag({ path: path.resolve(import.meta.dirname, '../../assets/disable-animation.css') });
    }
  }

  private async expose() {
    const exposed: Exposed = {
      emitCapture: (opt: ScreenshotOptions, clientStoryKey: string) =>
        this.subscribeScreenshotOptions(opt, clientStoryKey),
      getBaseScreenshotOptions: () => this.baseScreenshotOptions,
      getCurrentVariantKey: () => this.currentVariantKey,
      waitBrowserMetricsStable: () => this.waitBrowserMetricsStable('preEmit'),
    };
    await Promise.all(Object.entries(exposed).map(([k, f]) => this.page.exposeFunction(k, f)));
  }

  private async reload() {
    await this.page.reload();
    await sleep(this.opt.viewportDelay);
    await this.addStyles();
  }

  private async waitIfTouched() {
    if (!this.touched) return;
    await sleep(this.opt.stateChangeDelay);
  }

  private async resetInputModality() {
    // A trusted pointer click on a focusable element (e.g. a `click` variant) switches Chromium into mouse
    // modality, after which programmatic focus (`focus` variants, component autofocus) no longer matches
    // `:focus-visible`. That state survives blur and re-renders, so captures depended on which stories ran
    // earlier on the same page. A trusted key press restores the default state for every capture.
    await this.page.keyboard.press('Shift');
  }

  private async resetIfTouched(screenshotOptions: StrictScreenshotOptions) {
    const story = this.currentStory;
    if (!this.touched || !story) return;
    this.debug('Reset story because page state got dirty in this request.', this.currentRequestId);

    // Clear the browser's mouse state.
    if (screenshotOptions.click) {
      await this.page.$eval(screenshotOptions.click, (e: unknown) => (e as HTMLElement)?.blur());
    }
    if (screenshotOptions.focus) {
      await this.page.$eval(screenshotOptions.focus, (e: unknown) => (e as HTMLElement)?.blur());
    }
    await this.page.mouse.move(0, 0);
    await this.page.mouse.click(0, 0);

    await this.setCurrentStory(story, { forceRerender: true });
    this.touched = false;

    return;
  }

  private async subscribeScreenshotOptions(opt: ScreenshotOptions, clientStoryKey: string) {
    if (this.touched) return;

    if (!this.currentStory) {
      this.emitter.emit('error', new InvalidCurrentStoryStateError());
      return;
    }

    // Sometimes preview window emits options before completion of change story.
    // So asserts story identifiers between this class hold and sent from browser and skips procedure if they're not equal.
    if (this.currentStory.id !== clientStoryKey) {
      this.debug('This options was sent from previous story', this.currentStory.id, clientStoryKey);
      return;
    }

    // Sometimes preview window emits options twice for a story.
    // The second(or more) options should be ignore because we should guarantee just one PNG for each request.
    if (this.processedStories.has(this.currentRequestId)) {
      this.debug(
        'This story was already processed:',
        this.currentRequestId,
        this.currentStory.kind,
        this.currentStory.story,
        this.currentVariantKey,
        JSON.stringify(opt),
      );
      return;
    }
    this.processedStories.add(this.currentRequestId);

    this.debug(
      'Start to process to screenshot story:',
      this.currentRequestId,
      this.currentStory.kind,
      this.currentStory.story,
      this.currentVariantKey,
      JSON.stringify(opt),
    );

    this.emitter.emit('screenshotOptions', opt);
  }

  private async waitForOptionsFromBrowser() {
    return new Promise<ScreenshotOptions | undefined>((resolve, reject) => {
      const id = setTimeout(() => {
        this.emitter.removeAllListeners();
        if (!this.currentStory) {
          reject(new InvalidCurrentStoryStateError());
          return;
        }
        if (this.currentStoryRetryCount < this.opt.captureMaxRetryCount) {
          this.opt.logger.warn(
            `Capture timeout exceeded in ${
              this.opt.captureTimeout + ''
            } msec. Retry to screenshot this story after this sequence.`,
            this.currentStory.kind,
            this.currentStory.story,
          );
          resolve(undefined);
          return;
        }
        reject(new ScreenshotTimeoutError(this.opt.captureTimeout, this.currentStory));
      }, this.opt.captureTimeout);

      const cb = (opt?: ScreenshotOptions) => {
        clearTimeout(id);
        this.emitter.removeAllListeners();
        resolve(opt);
      };

      this.emitter.once('screenshotOptions', cb);
    });
  }

  private async setViewport(opt: StrictScreenshotOptions) {
    if (!this.currentStory) {
      throw new InvalidCurrentStoryStateError();
    }

    let nextViewport: Viewport;

    if (typeof opt.viewport === 'string') {
      if (opt.viewport.match(/^\d+$/)) {
        // For case such as `--viewport "800"`.
        nextViewport = { width: +opt.viewport, height: 600 };
      } else if (opt.viewport.match(/^\d+x\d+$/)) {
        // For case such as `--viewport "800x600"`.
        const [w, h] = opt.viewport.split('x');
        nextViewport = { width: +w, height: +h };
      } else {
        // Handle as Puppeteer device descriptor.
        const devices = await getDeviceDescriptors();
        const hit = devices.find(d => d.viewport === opt.viewport);
        if (!hit) {
          this.opt.logger.warn(
            `Skip screenshot for ${this.opt.logger.color.yellow(
              JSON.stringify(this.currentStory),
            )} because the viewport ${this.opt.logger.color.magenta(
              opt.viewport,
            )} is not registered in 'puppeteer/DeviceDescriptor'.`,
          );
          return false;
        }
        nextViewport = hit.viewport;
      }
    } else {
      nextViewport = opt.viewport;
    }

    // Sometimes, `page.screenshot` is completed before applying viewport unfortunately.
    // So we compare the current viewport with the next viewport and wait for `opt.viewportDelay` time if they are different.
    if (!this.viewport || JSON.stringify(this.viewport) !== JSON.stringify(nextViewport)) {
      this.debug('Change viewport', JSON.stringify(nextViewport));
      await this.page.setViewport(nextViewport);

      // Setting isMobile or hasTouch properties will reload the page.
      // See also https://github.com/puppeteer/puppeteer/blob/main/docs/api/puppeteer.viewport.md
      const willBeReloaded =
        nextViewport.isMobile !== this.viewport?.isMobile || nextViewport.hasTouch !== this.viewport?.hasTouch;
      this.viewport = nextViewport;
      if (willBeReloaded || this.opt.reloadAfterChangeViewport) {
        this.processedStories.delete(this.currentRequestId);
        await Promise.all([this.reload(), this.waitForOptionsFromBrowser()]);
      } else {
        await sleep(this.opt.viewportDelay);
      }
    }

    return true;
  }

  private async warnIfTargetElementNotFound(selector: string) {
    const targetElement = await this.page.$(selector);
    if (this.currentStory && !targetElement) {
      this.logger.warn(
        `No matched element for "${this.logger.color.yellow(selector)}" in story "${this.currentStory.id}".`,
      );
    }
  }

  private isRecoverableInteractionSelectorError(error: unknown) {
    return error instanceof Error && error.message.includes('No element found for selector:');
  }

  private async waitForInteractionTarget(selector: string) {
    try {
      await this.page.waitForSelector(selector, { timeout: this.interactionSelectorWaitTimeout });
      return true;
    } catch {
      await this.warnIfTargetElementNotFound(selector);
      return false;
    }
  }

  private async setHover(screenshotOptions: StrictScreenshotOptions) {
    if (!screenshotOptions.hover) return;
    if (!(await this.waitForInteractionTarget(screenshotOptions.hover))) {
      throw new Error(`No element found for selector: ${screenshotOptions.hover}`);
    }
    await this.page.hover(screenshotOptions.hover);
    this.touched = true;
    return;
  }

  private async setFocus(screenshotOptions: StrictScreenshotOptions) {
    if (!screenshotOptions.focus) return;
    if (!(await this.waitForInteractionTarget(screenshotOptions.focus))) {
      throw new Error(`No element found for selector: ${screenshotOptions.focus}`);
    }
    await this.page.focus(screenshotOptions.focus);
    this.touched = true;
    return;
  }

  private async setClick(screenshotOptions: StrictScreenshotOptions) {
    if (!screenshotOptions.click) return;
    if (!(await this.waitForInteractionTarget(screenshotOptions.click))) {
      throw new Error(`No element found for selector: ${screenshotOptions.click}`);
    }
    await this.page.click(screenshotOptions.click);
    this.touched = true;
    return;
  }

  private async waitForResources(screenshotOptions: StrictScreenshotOptions) {
    if (!screenshotOptions.waitAssets && !screenshotOptions.waitImages) return;
    this.debug('Wait for requested resources resolved', this.resourceWatcher.getRequestedUrls());
    await this.resourceWatcher.waitForRequestsComplete();
  }

  private async waitBrowserMetricsStable(phase: 'preEmit' | 'postEmit') {
    const mw = new MetricsWatcher(this.page, this.opt.metricsWatchRetryCount);
    const checkCountUntillStable = await mw.waitForStable();
    this.debug(`[${phase}] Browser metrics got stable in ${checkCountUntillStable} times checks.`);
    if (checkCountUntillStable >= this.opt.metricsWatchRetryCount) {
      this.opt.logger.warn(
        `Metrics is not stable while ${this.opt.metricsWatchRetryCount} times. ${this.opt.logger.color.yellow(
          JSON.stringify(this.currentStory),
        )}`,
      );
    }
  }

  /**
   *
   * Detects whether Storybook shows its error display instead of the story, e.g. because the story threw while rendering.
   *
   * @returns The displayed error, or null if the story rendered normally.
   *
   **/
  private async detectStoryError(): Promise<StoryErrorInfo | null> {
    // The page may have been reloaded or its frame detached meanwhile, e.g. when a capture timed out and the story
    // is queued for a retry. Nothing can be detected then, and the retry must not be turned into a failed run.
    return this.page
      .evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const recorded = (window as any).__storycapStoryError as StoryErrorInfo | null | undefined;
        if (recorded) return recorded;
        if (!document.body.classList.contains('sb-show-errordisplay')) return null;
        return {
          message: document.getElementById('error-message')?.textContent?.trim() || 'Unknown error',
          stack: document.getElementById('error-stack')?.textContent?.trim() || '',
        };
      })
      .catch((error: unknown) => {
        this.debug('Could not check for a story error:', error instanceof Error ? error.message : error);
        return null;
      });
  }

  /**
   *
   * Forgets the render error recorded for the previous story before setting the next one.
   *
   * Render errors are recorded from Storybook's channel by {@link watchStoryErrorsInPage}, because the error display
   * alone is not reliable: Storybook's Vue 3 renderer reports an error thrown while mounting, which shows the error
   * display, but then calls `showMain()` unconditionally once `mount()` returns. The display is hidden again before
   * it can be detected and the story is captured blank. The `storyThrewException` event is emitted either way, and
   * `storyErrored` covers stories that fail before rendering.
   *
   **/
  override async setCurrentStory(story: Story, opt: { forceRerender?: boolean } = {}) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await this.page.evaluate(() => ((window as any).__storycapStoryError = null));
    await super.setCurrentStory(story, opt);
  }

  private storyErrorResult(storyError: StoryErrorInfo): ScreenshotResult {
    this.debug('Story rendered error display:', this.currentRequestId, storyError.message);
    return { buffer: null, succeeded: true, variantKeysToPush: [], defaultVariantSuffix: '', storyError };
  }

  private async waitForNextIdle(timeout = 3000) {
    await this.page.evaluate(
      (idleTimeoutMs: number) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        new Promise(res => (window as any).requestIdleCallback(res, { timeout: idleTimeoutMs })),
      timeout,
    );
  }

  /**
   *
   * Takes screenshots until the configured number of consecutive ones are byte-identical.
   *
   * Used by the `image-stable` capture stability strategy instead of waiting for the browser to become idle, which
   * headless Chrome may not grant before the idle timeout. If the screenshots don't converge, the last one is used and
   * all attempts are stored in `unstableScreenshotAttemptsDir` for inspection.
   *
   * @returns PNG image buffer of the last screenshot taken
   *
   **/
  private async captureStableScreenshot(
    screenshotArgs: ScreenshotArgs,
    screenshotOptions: StrictScreenshotOptions,
    fileSystem: FileSystem,
  ) {
    const interval = Math.max(0, screenshotOptions.stableScreenshotIntervalMs);
    const consecutiveMatches = Math.max(2, screenshotOptions.stableScreenshotConsecutiveMatches);
    const maxAttempts = Math.max(consecutiveMatches, screenshotOptions.stableScreenshotMaxAttempts);
    const attempts: Buffer[] = [];

    for (let attempt = 1; attempt <= maxAttempts; ++attempt) {
      if (attempt > 1 && interval > 0) await sleep(interval);
      const buffer = await this.page.screenshot(screenshotArgs);
      if (!Buffer.isBuffer(buffer)) {
        throw new Error('Unexpected screenshot payload while capturing stable screenshot.');
      }
      attempts.push(buffer);
      if (areLastBuffersEqual(attempts, consecutiveMatches)) {
        this.debug(`Stable screenshot resolved after ${attempt}/${maxAttempts} attempts.`);
        return buffer;
      }
    }

    if (!this.currentStory) {
      throw new InvalidCurrentStoryStateError();
    }
    const { kind, story } = this.currentStory;
    const suffix =
      this.currentVariantKey.isDefault && screenshotOptions.defaultVariantSuffix
        ? [screenshotOptions.defaultVariantSuffix]
        : this.currentVariantKey.keys;
    const savedPaths = await Promise.all(
      attempts.map((buffer, index) =>
        fileSystem.saveUnstableScreenshotAttempt(
          screenshotOptions.unstableScreenshotAttemptsDir,
          kind,
          story,
          suffix,
          index + 1,
          buffer,
        ),
      ),
    );
    const savedDir = savedPaths[0] && path.dirname(savedPaths[0]);
    this.opt.logger.warn(
      `Stable screenshot did not converge after ${maxAttempts} attempts. Using the last attempt for ` +
        `${this.opt.logger.color.yellow(`${kind}/${story}`)} ` +
        `(variant: ${this.currentVariantKey.isDefault ? 'default' : this.currentVariantKey.keys.join(' -> ')}).` +
        (savedDir ? ` Stored unstable attempts in ${savedDir}.` : ''),
    );
    return attempts[attempts.length - 1];
  }

  private logInvalidVariantKeysReason(reason: InvalidVariantKeysReason | null) {
    if (reason) {
      if (reason.type === 'notFound') {
        this.logger.warn(
          `Invalid variants. The variant key '${reason.to}' does not exist(story id: ${this.currentStory!.id}).`,
        );
      } else if (reason.type === 'circular') {
        this.logger.warn(
          `Invalid variants. Reference ${reason.refs.join(' -> ')} is circular(story id: ${this.currentStory!.id}).`,
        );
      }
    }
  }

  /**
   * Captures screenshot as a PNG image buffer from a story.
   *
   * @param requestId - Represents an identifier for the screenshot
   * @param variantKey - Variant identifier for the screenshot
   * @param retryCount - The number which represents how many attempting to capture this story and variant
   * @param logger - Logger instance
   * @param forwardConsoleLogs - Whether to forward logs from the page to the user's console
   * @param trace - Whether to record a CPU trace per screenshot
   *
   * @returns PNG buffer, whether the capturing process is succeeded or not, additional variant keys if they are emitted, and file name suffix for default the default variant.
   *
   * @remarks
   *
   * - Throws an error if `retryCount` is equal to `opt.captureMaxRetryCount` and this capturing process is failed
   *
   **/
  async screenshot(
    requestId: string,
    story: Story,
    variantKey: VariantKey,
    retryCount: number,
    logger: Logger,
    forwardConsoleLogs: boolean,
    trace: boolean,
    fileSystem: FileSystem,
  ): Promise<ScreenshotResult> {
    this.currentRequestId = requestId;
    this.currentVariantKey = variantKey;
    this.currentStoryRetryCount = retryCount;
    let emittedScreenshotOptions: ScreenshotOptions | undefined;
    this.resourceWatcher.clear();

    function onConsoleLog(msg: ConsoleMessage) {
      const niceMessage = `From ${requestId} (${msg.type()}): ${msg.text()}`;

      if (forwardConsoleLogs) {
        switch (msg.type()) {
          case 'warn':
            logger.warn(niceMessage);
            break;
          case 'error':
            logger.error(niceMessage);
            break;
          case 'debug':
            logger.debug(niceMessage);
            break;
          default:
            logger.log(niceMessage);
            break;
        }
      } else {
        logger.debug(niceMessage);
      }
    }

    this.page.on('console', onConsoleLog);

    if (trace) {
      // Begin CPU trace, don't write to file, store it in memory
      await this.page.tracing.start();
    }

    // Capture this outside so it can be used for the filePath generation for the trace
    let defaultVariantSuffix: string | undefined;

    try {
      await this.resetInputModality();
      await this.setCurrentStory(story, { forceRerender: true });

      if (this.mode === 'managed') {
        // Screenshot options are emitted form the browser process when managed mode.
        try {
          emittedScreenshotOptions = await this.waitForOptionsFromBrowser();
        } catch (error) {
          if (error instanceof ScreenshotTimeoutError) {
            this.opt.logger.warn(
              `Capture trigger was not emitted for ${story.kind}/${story.story}. Falling back to CLI screenshot options.`,
            );
            emittedScreenshotOptions = pickupWithVariantKey(this.baseScreenshotOptions, this.currentVariantKey);
          } else {
            throw error;
          }
        }
        if (!this.currentStory) {
          throw new InvalidCurrentStoryStateError();
        }
        if (!emittedScreenshotOptions) {
          // A story which failed to render never triggers the capture, so there's no point in retrying it.
          const storyError = await this.detectStoryError();
          if (storyError) {
            if (this.opt.failOnStoryError) return this.storyErrorResult(storyError);
            emittedScreenshotOptions = pickupWithVariantKey(this.baseScreenshotOptions, this.currentVariantKey);
          } else {
            // End this capturing process as failure of timeout if emitter don't resolve screenshot options.
            return { buffer: null, succeeded: false, variantKeysToPush: [], defaultVariantSuffix: '' };
          }
        }
      } else {
        await sleep(this.opt.delay);
        await this.waitBrowserMetricsStable('preEmit');
        // Use only `baseScreenshotOptions` when simple mode.
        emittedScreenshotOptions = pickupWithVariantKey(this.baseScreenshotOptions, this.currentVariantKey);
      }

      // Set defaultVariantSuffix as soon as it's known
      defaultVariantSuffix = emittedScreenshotOptions.defaultVariantSuffix;

      const mergedScreenshotOptions = mergeScreenshotOptions(this.baseScreenshotOptions, emittedScreenshotOptions);

      // Get keys for variants included in the screenshot options in order to queue capturing them after this sequence.
      const [invalidReason, keys] = extractVariantKeys(mergedScreenshotOptions);
      const variantKeysToPush = this.currentVariantKey.isDefault ? keys : [];
      this.logInvalidVariantKeysReason(invalidReason);

      // End this capturing process as success if `skip` set true.
      if (mergedScreenshotOptions.skip) {
        await this.waitForDebugInput();
        return { buffer: null, succeeded: true, variantKeysToPush, defaultVariantSuffix: '' };
      }

      this.touched = false;

      // Change browser's viewport if needed.
      const vpChanged = await this.setViewport(mergedScreenshotOptions);
      // Skip to capture if the viewport option is invalid.
      if (!vpChanged) return { buffer: null, succeeded: true, variantKeysToPush: [], defaultVariantSuffix: '' };

      // Bail out before interacting with elements which a broken story doesn't render.
      if (this.opt.failOnStoryError) {
        const storyError = await this.detectStoryError();
        if (storyError) return this.storyErrorResult(storyError);
      }

      // Modify elements state.
      await this.setHover(mergedScreenshotOptions);
      await this.setFocus(mergedScreenshotOptions);
      await this.setClick(mergedScreenshotOptions);
      await this.waitIfTouched();

      // Wait until browser main thread gets stable.
      await this.waitForResources(mergedScreenshotOptions);
      await this.waitBrowserMetricsStable('postEmit');

      const imageStable = mergedScreenshotOptions.captureStabilityStrategy === 'image-stable';
      if (!imageStable) await this.waitForNextIdle(mergedScreenshotOptions.idleTimeoutMs);

      // The story may also have failed after the interactions or while waiting for stability.
      const storyError = await this.detectStoryError();
      if (storyError && this.opt.failOnStoryError) {
        await this.resetIfTouched(mergedScreenshotOptions);
        return this.storyErrorResult(storyError);
      }

      // Get PNG image buffer
      const screenshotArgs: ScreenshotArgs = {
        fullPage: emittedScreenshotOptions.fullPage,
        omitBackground: emittedScreenshotOptions.omitBackground,
        captureBeyondViewport: emittedScreenshotOptions.captureBeyondViewport,
        clip: emittedScreenshotOptions.clip ?? undefined,
      };
      const rawBuffer = imageStable
        ? await this.captureStableScreenshot(screenshotArgs, mergedScreenshotOptions, fileSystem)
        : await this.page.screenshot(screenshotArgs);

      let buffer: Buffer | null = null;
      if (Buffer.isBuffer(rawBuffer)) {
        buffer = rawBuffer;
      }

      // We should reset elements state(e.g. focusing, hovering, clicking) for future screenshot for this story.
      await this.resetIfTouched(mergedScreenshotOptions);

      await this.waitForDebugInput();

      return {
        buffer,
        succeeded: true,
        variantKeysToPush,
        defaultVariantSuffix,
        storyError: storyError ?? undefined,
      };
    } catch (error) {
      if (
        (isRecoverableNavigationContextError(error) || this.isRecoverableInteractionSelectorError(error)) &&
        this.currentStory
      ) {
        if (this.currentStoryRetryCount < this.opt.captureMaxRetryCount) {
          this.opt.logger.warn(
            `Recovered a transient browser capture race while capturing ${this.currentStory.kind}/${this.currentStory.story}. ` +
              `Retrying (${this.currentStoryRetryCount + 1}/${this.opt.captureMaxRetryCount}). Reason: ${error instanceof Error ? error.message : String(error)}`,
          );
          return { buffer: null, succeeded: false, variantKeysToPush: [], defaultVariantSuffix: '' };
        }

        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed to capture ${this.currentStory.kind}/${this.currentStory.story} after ${this.opt.captureMaxRetryCount} retries: ${errorMessage}`,
        );
      }
      throw error;
    } finally {
      this.page.off('console', onConsoleLog);

      if (trace) {
        // Finish CPU trace.
        const traceBuffer = await this.page.tracing.stop();
        if (traceBuffer) {
          // Calculate the suffix and save the trace to the file.
          const suffix = variantKey.isDefault && defaultVariantSuffix ? [defaultVariantSuffix] : variantKey.keys;
          await fileSystem.saveTrace(story.kind, story.story, suffix, Buffer.from(traceBuffer));
        }
      }
    }
  }
}
