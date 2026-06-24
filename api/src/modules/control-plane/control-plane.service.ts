import { env } from "../../env.js";

export interface ControlPlaneCapabilityStatus {
  enabled: boolean;
  implemented: boolean;
}

export interface ControlPlaneStatus {
  mode: "noop";
  capabilities: {
    auth: ControlPlaneCapabilityStatus;
    worker: ControlPlaneCapabilityStatus;
    remoteStorage: ControlPlaneCapabilityStatus;
    challengeDetection: ControlPlaneCapabilityStatus;
    proxyManagement: ControlPlaneCapabilityStatus;
  };
}

export class NoopControlPlaneService {
  getStatus(): ControlPlaneStatus {
    return {
      mode: "noop",
      capabilities: {
        auth: this.capability(env.STEEL_AUTH_ENABLED),
        worker: this.capability(env.STEEL_WORKER_ENABLED),
        remoteStorage: this.capability(env.STEEL_REMOTE_STORAGE_ENABLED),
        challengeDetection: this.capability(env.STEEL_CHALLENGE_DETECTION_ENABLED),
        proxyManagement: this.capability(env.STEEL_PROXY_MANAGEMENT_ENABLED),
      },
    };
  }

  private capability(enabled: boolean): ControlPlaneCapabilityStatus {
    return {
      enabled,
      implemented: false,
    };
  }
}
