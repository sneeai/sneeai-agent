import { CanvasSession, CanvasSessionRoutingError } from "./session.js";
import { ToolAuthorizationReplayGuard } from "../tool-authorization.js";
import { LEGACY_PROFILE_KEY } from "../profile.js";

type ActiveCanvasBinding = {
    profileKey: string;
    clientId: string;
    sequence: number;
    activatedAt: number;
};

const ACTIVE_CANVAS_BINDING_TTL_MS = 5 * 60 * 1000;

export { CanvasSessionRoutingError } from "./session.js";

/** 按 profile 隔离网页、画布状态、附件、线程事件和工具调用目标。 */
export class CanvasSessionRegistry {
    private sessions = new Map<string, CanvasSession>();
    private activeBindings = new Map<string, ActiveCanvasBinding>();
    private expiredBindings = new Set<string>();
    private replayGuard = new ToolAuthorizationReplayGuard();
    private activationSequence = 0;

    constructor(private readonly options: { now?: () => number; bindingTtlMs?: number } = {}) {}

    session(profileKey: string) {
        let session = this.sessions.get(profileKey);
        if (!session) {
            session = new CanvasSession({ profileKey, replayGuard: this.replayGuard, now: this.options.now });
            this.sessions.set(profileKey, session);
        }
        return session;
    }

    /** 由已授权网页声明最近获得焦点的画布，供本机 MCP 自动路由。 */
    activateCanvas(profileKey: string, clientId: string) {
        this.cleanupBindings();
        const session = this.session(profileKey);
        session.activateClient(clientId);
        const binding: ActiveCanvasBinding = {
            profileKey,
            clientId,
            sequence: ++this.activationSequence,
            activatedAt: (this.options.now || Date.now)(),
        };
        const key = bindingKey(profileKey, clientId);
        this.expiredBindings.delete(key);
        this.activeBindings.set(key, binding);
    }

    /** 只续租已由焦点事件激活的画布，状态上报不得隐式抢占路由。 */
    touchCanvas(profileKey: string, clientId: string) {
        this.cleanupBindings();
        const binding = this.activeBindings.get(bindingKey(profileKey, clientId));
        if (!binding) return false;
        binding.activatedAt = this.now();
        return true;
    }

    /**
     * 为旧版插件的“本机 token + /api/tools”请求选择目标。
     * 不接受插件传入的任意 profile，也不在多画布之间猜测。
     */
    resolveLocalToolSession() {
        this.cleanupBindings();
        const bindings = [...this.activeBindings.values()]
            .sort((left, right) => right.sequence - left.sequence);
        const selected = bindings[0];
        if (selected) {
            const session = this.sessions.get(selected.profileKey)!;
            session.activateClient(selected.clientId);
            return session;
        }

        const canvases = [...this.sessions.entries()].flatMap(([profileKey, session]) =>
            session.connectedClientIds().map((clientId) => ({ profileKey, clientId, session })),
        );
        if (canvases.length > 1) {
            throw new CanvasSessionRoutingError("canvas_binding_ambiguous", "存在多个画布，当前 MCP 未绑定活动画布");
        }
        const legacy = canvases[0];
        if (legacy?.profileKey === LEGACY_PROFILE_KEY) {
            legacy.session.activateClient(legacy.clientId);
            return legacy.session;
        }
        if (legacy && this.expiredBindings.has(bindingKey(legacy.profileKey, legacy.clientId))) {
            throw new CanvasSessionRoutingError("canvas_binding_expired", "当前画布绑定已过期，请重新聚焦网页");
        }
        throw new CanvasSessionRoutingError("canvas_not_connected", "当前没有已连接画布");
    }

    activeBindingKey() {
        this.cleanupBindings();
        const selected = [...this.activeBindings.values()].sort((left, right) => right.sequence - left.sequence)[0];
        return selected ? bindingKey(selected.profileKey, selected.clientId) : null;
    }

    /** 保留旧健康字段，同时提供可单独放入 diagnostics 的聚合状态。 */
    health() {
        this.cleanupBindings();
        const states = [...this.sessions.values()].map((session) => session.health());
        return {
            ok: true,
            hasCanvas: states.some((state) => state.hasCanvas),
            activeCanvas: this.activeBindings.size > 0,
            clients: states.reduce((total, state) => total + state.clients, 0),
            codexBusy: states.some((state) => state.codexBusy),
            profiles: this.sessions.size,
        };
    }

    get codexBusy() {
        return [...this.sessions.values()].some((session) => session.codexBusy);
    }

    get runtimeBusy() {
        return [...this.sessions.values()].some((session) => session.runtimeBusy);
    }

    /** 终止并删除单个 profile，不影响其他已授权网页会话。 */
    disposeProfile(profileKey: string, reason = "Sneeai Agent authorization expired") {
        const session = this.sessions.get(profileKey);
        if (!session) return false;
        session.dispose(reason);
        this.sessions.delete(profileKey);
        this.activeBindings.forEach((binding, key) => {
            if (binding.profileKey === profileKey) this.activeBindings.delete(key);
        });
        this.expiredBindings.forEach((key) => {
            if (key.startsWith(`${profileKey}\0`)) this.expiredBindings.delete(key);
        });
        return true;
    }

    dispose() {
        this.sessions.forEach((session) => session.dispose());
        this.sessions.clear();
        this.activeBindings.clear();
        this.expiredBindings.clear();
        this.replayGuard.clear();
    }

    private cleanupBindings() {
        const now = this.now();
        const ttlMs = this.options.bindingTtlMs ?? ACTIVE_CANVAS_BINDING_TTL_MS;
        this.activeBindings.forEach((binding, key) => {
            const connected = this.sessions.get(binding.profileKey)?.hasConnectedClient(binding.clientId) || false;
            if (!connected) {
                this.activeBindings.delete(key);
                this.expiredBindings.delete(key);
                return;
            }
            if (binding.activatedAt + ttlMs <= now) {
                this.activeBindings.delete(key);
                this.expiredBindings.add(key);
            }
        });
        this.expiredBindings.forEach((key) => {
            const [profileKey, clientId] = key.split("\0", 2);
            if (!profileKey || !clientId || !this.sessions.get(profileKey)?.hasConnectedClient(clientId)) this.expiredBindings.delete(key);
        });
    }

    private now() {
        return (this.options.now || Date.now)();
    }
}

function bindingKey(profileKey: string, clientId: string) {
    return `${profileKey}\0${clientId}`;
}
