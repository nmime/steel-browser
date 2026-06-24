import { FastifyBaseLogger } from "fastify";
import { mkdir } from "fs/promises";
import os from "os";
import path, { dirname } from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import { env } from "../env.js";
import { BrowserFingerprintWithHeaders } from "fingerprint-generator";
import { CredentialsOptions, SessionDetails } from "../modules/sessions/sessions.schema.js";
import {
  BrowserLaunchExtra,
  BrowserLauncherOptions,
  OptimizeBandwidthOptions,
} from "../types/index.js";
import { IProxyServer, ProxyServer } from "../utils/proxy.js";
import { redactProxyUrl, resolveProxyUrl } from "../utils/proxy-url.js";
import { getBaseUrl, getUrl } from "../utils/url.js";
import { CDPService } from "./cdp/cdp.service.js";
import { ShutdownReason } from "./cdp/plugins/core/base-plugin.js";
import { JsonFileMetadataStore, resolveMetadataFilePath } from "./metadata/index.js";
import { CookieData } from "./context/types.js";
import { FileService } from "./file.service.js";
import { SeleniumService } from "./selenium.service.js";
import { TimezoneFetcher } from "./timezone-fetcher.service.js";
import { deepMerge } from "../utils/context.js";
import { WorkerRuntimeService } from "./workers/worker-runtime.service.js";
import { managedProxyStore, ProxyStore } from "./proxies/proxy.store.js";
import { ProfileSnapshotService } from "./profiles/profile-snapshot.service.js";
import { defaultProfileStore } from "./profiles/profile.store.js";

type Session = SessionDetails & {
  completion: Promise<void>;
  complete: (value: void) => void;
  proxyServer: IProxyServer | undefined;
  userDataDir?: string;
  profileId?: string;
};

type PersistedProxyMetadata = {
  sessionId: string;
  proxy?: string;
  txBytes: number;
  rxBytes: number;
  updatedAt: string;
};

type PersistedSessionRegistry = {
  version: 1;
  active?: SessionDetails;
  pastSessions: SessionDetails[];
  proxies: Record<string, PersistedProxyMetadata>;
};

const sessionStats = {
  duration: 0,
  eventCount: 0,
  timeout: 0,
  creditsUsed: 0,
  proxyTxBytes: 0,
  proxyRxBytes: 0,
};

const defaultSession = {
  status: "idle" as SessionDetails["status"],
  websocketUrl: getBaseUrl("ws"),
  debugUrl: getUrl("v1/sessions/debug"),
  debuggerUrl: getUrl("v1/devtools/inspector.html"),
  sessionViewerUrl: getBaseUrl(),
  dimensions: { width: 1920, height: 1080 },
  userAgent: "",
  isSelenium: false,
  proxy: "",
  solveCaptcha: false,
};

export function resolveSessionUserDataDir(options: {
  userDataDir?: string;
  persist?: boolean;
  chromeUserDataDir?: string;
}): string {
  if (options.userDataDir) {
    return options.userDataDir;
  }

  if (options.persist === true) {
    return path.join(dirname(fileURLToPath(import.meta.url)), "..", "..", "user-data-dir");
  }

  return (
    options.chromeUserDataDir || env.CHROME_USER_DATA_DIR || path.join(os.tmpdir(), "steel-chrome")
  );
}

export function normalizeSessionCredentials(credentials: CredentialsOptions): CredentialsOptions {
  if (!credentials) {
    return credentials;
  }

  return {
    ...credentials,
    autoSubmit: credentials.autoSubmit ?? false,
  };
}

export type ProxyFactory = (
  proxyUrl: string,
  options?: OptimizeBandwidthOptions,
) => Promise<IProxyServer> | IProxyServer;

export class SessionService {
  private logger: FastifyBaseLogger;
  private cdpService: CDPService;
  private seleniumService: SeleniumService;
  private fileService: FileService;
  private timezoneFetcher: TimezoneFetcher;
  private sessionMetadataStore: JsonFileMetadataStore<PersistedSessionRegistry>;
  private workerRuntime?: WorkerRuntimeService;
  private proxyStore: ProxyStore;
  private profileSnapshots: ProfileSnapshotService;
  public proxyFactory: ProxyFactory = (proxyUrl) => new ProxyServer(proxyUrl);

  public pastSessions: Session[] = [];
  public activeSession: Session;

  public resolveProxyUrl(proxyUrl?: string | null): string | undefined {
    return resolveProxyUrl(proxyUrl, {
      url: env.PROXY_URL,
      username: env.PROXY_USERNAME,
      password: env.PROXY_PASSWORD,
    });
  }

  constructor(config: {
    cdpService: CDPService;
    seleniumService: SeleniumService;
    fileService: FileService;
    logger: FastifyBaseLogger;
    workerRuntime?: WorkerRuntimeService;
    proxyStore?: ProxyStore;
    metadataStorePath?: string;
  }) {
    this.cdpService = config.cdpService;
    this.seleniumService = config.seleniumService;
    this.fileService = config.fileService;
    this.logger = config.logger;
    this.workerRuntime = config.workerRuntime;
    this.proxyStore = config.proxyStore ?? managedProxyStore;
    this.profileSnapshots = new ProfileSnapshotService(defaultProfileStore, this.fileService);
    this.timezoneFetcher = new TimezoneFetcher(config.logger);
    this.sessionMetadataStore = new JsonFileMetadataStore<PersistedSessionRegistry>({
      filePath: resolveMetadataFilePath(
        "sessions",
        config.metadataStorePath ?? env.STEEL_SESSIONS_STORE_PATH,
        env.STEEL_METADATA_STORE_PATH,
      ),
      defaults: () => ({ version: 1, pastSessions: [], proxies: {} }),
    });
    this.activeSession = {
      id: uuidv4(),
      createdAt: new Date().toISOString(),
      ...defaultSession,
      ...sessionStats,
      userAgent: this.cdpService.getUserAgent() ?? "",
      dimensions: this.cdpService.getDimensions(),
      completion: Promise.resolve(),
      complete: () => {},
      proxyServer: undefined,
    };
    this.hydratePersistedSessions();
  }

  public async startSession(options: {
    sessionId?: string;
    proxyUrl?: string;
    proxyPoolId?: string;
    proxyLeaseId?: string;
    userAgent?: string;
    sessionContext?: {
      cookies?: CookieData[];
      localStorage?: Record<string, Record<string, any>>;
    };
    isSelenium?: boolean;
    fingerprint?: BrowserFingerprintWithHeaders;
    logSinkUrl?: string;
    userDataDir?: string;
    persist?: boolean;
    profileId?: string;
    profileVersion?: number;
    blockAds?: boolean;
    optimizeBandwidth?: boolean | OptimizeBandwidthOptions;
    extensions?: string[];
    timezone?: string;
    dimensions?: { width: number; height: number };
    extra?: BrowserLaunchExtra;
    credentials: CredentialsOptions;
    skipFingerprintInjection?: boolean;
    userPreferences?: Record<string, any>;
    deviceConfig?: { device: "desktop" | "mobile" };
    fullscreen?: boolean;
    headless?: boolean;
    dangerouslyLogRequestDetails?: boolean;
    caCertificates?: string[];
  }): Promise<SessionDetails> {
    this.workerRuntime?.assertCanStartSession(this.activeSession);

    const {
      sessionId,
      proxyUrl,
      proxyPoolId,
      proxyLeaseId,
      userAgent,
      sessionContext,
      extensions,
      logSinkUrl,
      dimensions,
      fingerprint,
      isSelenium,
      blockAds,
      optimizeBandwidth,
      extra,
      credentials,
      skipFingerprintInjection,
      userPreferences,
      deviceConfig,
      fullscreen,
      headless,
      dangerouslyLogRequestDetails,
      caCertificates,
    } = options;
    const { userDataDir: requestedUserDataDir, profileId, profileVersion } = options;
    const managedSessionId = sessionId || uuidv4();
    let activeProxyLeaseId = proxyLeaseId;
    let activeProxyPoolId = proxyPoolId;
    let leasedProxyUrl: string | undefined;

    if (proxyLeaseId) {
      leasedProxyUrl = await this.proxyStore.getLeaseProxyUrl(proxyLeaseId);
      if (!leasedProxyUrl) {
        throw new Error("Managed proxy lease was not found or is not active");
      }
      await this.proxyStore.assignLeaseSession(proxyLeaseId, managedSessionId);
      const lease = await this.proxyStore.getLease(proxyLeaseId);
      activeProxyPoolId = lease?.poolId ?? activeProxyPoolId;
    } else if (proxyPoolId) {
      const lease = await this.proxyStore.acquireLease({
        poolId: proxyPoolId,
        sessionId: managedSessionId,
      });
      activeProxyLeaseId = lease.id;
      leasedProxyUrl = await this.proxyStore.getLeaseProxyUrl(lease.id);
    }

    const resolvedProxyUrl = this.resolveProxyUrl(leasedProxyUrl ?? proxyUrl);

    // start fetching timezone as early as possible
    let timezonePromise: Promise<string>;
    if (options.timezone) {
      timezonePromise = Promise.resolve(options.timezone);
    } else {
      timezonePromise = this.timezoneFetcher.getTimezone(
        resolvedProxyUrl,
        env.DEFAULT_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone,
      );
    }

    // If dimensions not provided, get from CDP service
    const MIN_MOBILE_WIDTH = 508;
    const MIN_MOBILE_HEIGHT = 1074;
    const isMobileDevice = deviceConfig?.device === "mobile";
    const resolvedDimensions = dimensions || this.cdpService.getDimensions();
    const finalDimensions =
      isMobileDevice && resolvedDimensions
        ? {
            width: Math.max(resolvedDimensions.width, MIN_MOBILE_WIDTH),
            height: Math.max(resolvedDimensions.height, MIN_MOBILE_HEIGHT),
          }
        : resolvedDimensions;

    let materializedUserDataDir = requestedUserDataDir;
    if (profileId) {
      materializedUserDataDir =
        materializedUserDataDir ??
        path.join(os.tmpdir(), "steel-profiles", profileId, managedSessionId);
      await this.profileSnapshots.restore({
        profileId,
        version: profileVersion,
        targetUserDataDir: materializedUserDataDir,
      });
    }

    await this.resetSessionInfo({
      id: managedSessionId,
      status: "live",
      proxy: redactProxyUrl(resolvedProxyUrl),
      proxyPoolId: activeProxyPoolId,
      proxyLeaseId: activeProxyLeaseId,
      solveCaptcha: false,
      dimensions: finalDimensions,
      isSelenium,
      deviceConfig,
    });

    const userDataDir = resolveSessionUserDataDir({
      ...options,
      userDataDir: materializedUserDataDir,
    });
    await mkdir(userDataDir, { recursive: true });
    this.activeSession.userDataDir = userDataDir;
    this.activeSession.profileId = profileId;

    const defaultUserPreferences = {
      plugins: {
        always_open_pdf_externally: true,
        plugins_disabled: ["Chrome PDF Viewer"],
      },
    };

    const mergedUserPreferences = userPreferences
      ? deepMerge(defaultUserPreferences, userPreferences)
      : defaultUserPreferences;

    // Normalize optimizeBandwidth: true => enable all flags (except lists)
    const normalizeOptimizeBandwidth = (
      value: boolean | OptimizeBandwidthOptions | undefined,
    ): OptimizeBandwidthOptions | undefined => {
      if (value === true) {
        return { blockImages: true, blockMedia: true, blockStylesheets: true };
      }
      if (value && typeof value === "object") {
        return { ...value };
      }
      return undefined;
    };

    const normalizedOptimize = normalizeOptimizeBandwidth(optimizeBandwidth);

    if (resolvedProxyUrl) {
      this.activeSession.proxyServer = await this.proxyFactory(
        resolvedProxyUrl,
        normalizedOptimize,
      );
      await this.activeSession.proxyServer.listen();
    }

    const browserLauncherOptions: BrowserLauncherOptions = {
      options: {
        headless: headless ?? env.CHROME_HEADLESS,
        proxyUrl: this.activeSession.proxyServer?.url,
      },
      sessionContext,
      userAgent,
      blockAds,
      fingerprint,
      optimizeBandwidth: normalizedOptimize,
      extensions: extensions || [],
      logSinkUrl,
      timezone: timezonePromise,
      dimensions: finalDimensions,
      userDataDir,
      userPreferences: mergedUserPreferences,
      extra,
      credentials: normalizeSessionCredentials(credentials),
      skipFingerprintInjection,
      deviceConfig,
      fullscreen,
      dangerouslyLogRequestDetails,
      caCertificates,
    };

    if (isSelenium) {
      await this.cdpService.shutdown(ShutdownReason.MODE_SWITCH);
      await this.seleniumService.launch(browserLauncherOptions);

      Object.assign(this.activeSession, {
        websocketUrl: "",
        debugUrl: "",
        sessionViewerUrl: "",
        userAgent:
          userAgent ||
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        dimensions: this.cdpService.getDimensions(),
        deviceConfig,
      });

      await this.persistSessionRegistry();
      return this.toSessionDetails(this.activeSession);
    } else {
      await this.cdpService.startNewSession(browserLauncherOptions);

      Object.assign(this.activeSession, {
        websocketUrl: getBaseUrl("ws"),
        debugUrl: getUrl("v1/sessions/debug"),
        debuggerUrl: getUrl("v1/devtools/inspector.html"),
        sessionViewerUrl: getBaseUrl(),
        userAgent:
          this.cdpService.getUserAgent() ||
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        dimensions: this.cdpService.getDimensions(),
        deviceConfig,
      });
    }

    await this.persistSessionRegistry();
    return this.toSessionDetails(this.activeSession);
  }

  public async endSession(): Promise<SessionDetails> {
    this.activeSession.complete();
    this.activeSession.status = "released";
    this.activeSession.duration =
      new Date().getTime() - new Date(this.activeSession.createdAt).getTime();

    if (this.activeSession.proxyServer) {
      this.activeSession.proxyTxBytes = this.activeSession.proxyServer.txBytes;
      this.activeSession.proxyRxBytes = this.activeSession.proxyServer.rxBytes;
    }

    if (this.activeSession.proxyLeaseId) {
      await this.proxyStore.releaseLease(this.activeSession.proxyLeaseId);
    } else {
      await this.proxyStore.releaseLeasesForSession(this.activeSession.id);
    }

    if (this.activeSession.isSelenium) {
      this.seleniumService.close();
      await this.cdpService.launch();
    } else {
      await this.cdpService.endSession();
    }

    const releasedSession = this.activeSession;

    await this.resetSessionInfo({
      id: uuidv4(),
      status: "idle",
    });

    this.pastSessions.push(releasedSession);
    await this.persistSessionRegistry();

    return this.toSessionDetails(releasedSession);
  }

  public getActiveSessionDetails(): SessionDetails {
    return this.toSessionDetails(this.activeSession);
  }

  public getPastSessionDetails(): SessionDetails[] {
    return this.pastSessions.map((session) => this.toSessionDetails(session));
  }

  public getActiveUserDataDir(sessionId?: string): string | undefined {
    if (sessionId && sessionId !== this.activeSession.id) return undefined;
    return this.activeSession.userDataDir;
  }

  private toSessionDetails(session: Session): SessionDetails {
    const { completion, complete, proxyServer, userDataDir, profileId, ...details } = session;
    return details;
  }

  private async resetSessionInfo(overrides?: Partial<SessionDetails>): Promise<SessionDetails> {
    this.activeSession.complete();

    await this.activeSession.proxyServer?.close(true);
    this.activeSession.proxyServer = undefined;

    const { promise, resolve } = Promise.withResolvers<void>();
    this.activeSession = {
      id: uuidv4(),
      ...defaultSession,
      ...overrides,
      ...sessionStats,
      userAgent: this.cdpService.getUserAgent() ?? "",
      createdAt: new Date().toISOString(),
      completion: promise,
      complete: resolve,
      proxyServer: undefined,
    };

    await this.persistSessionRegistry();
    return this.activeSession;
  }

  private hydratePersistedSessions(): void {
    const state = this.sessionMetadataStore.loadSync();
    this.pastSessions = (state.pastSessions ?? []).map((session) =>
      this.fromSessionDetails(session),
    );
    if (state.active && state.active.status !== "idle") {
      this.pastSessions.push(
        this.fromSessionDetails({
          ...state.active,
          status: state.active.status === "live" ? "failed" : state.active.status,
          duration:
            state.active.duration || Date.now() - new Date(state.active.createdAt).getTime(),
        }),
      );
      this.persistSessionRegistry();
    }
  }

  private async persistSessionRegistry(): Promise<void> {
    const active = this.toSessionDetails(this.activeSession);
    const pastSessions = this.pastSessions.map((session) => this.toSessionDetails(session));
    const proxies = Object.fromEntries(
      [active, ...pastSessions]
        .filter((session) => session.proxy)
        .map((session) => [
          session.id,
          {
            sessionId: session.id,
            proxy: session.proxy,
            txBytes: session.proxyTxBytes,
            rxBytes: session.proxyRxBytes,
            updatedAt: new Date().toISOString(),
          } satisfies PersistedProxyMetadata,
        ]),
    );
    await this.sessionMetadataStore.save({ version: 1, active, pastSessions, proxies });
  }

  private fromSessionDetails(details: SessionDetails): Session {
    return {
      ...details,
      completion: Promise.resolve(),
      complete: () => {},
      proxyServer: undefined,
    };
  }

  public setProxyFactory(factory: ProxyFactory) {
    this.proxyFactory = factory;
  }
}
