/**
 * Mini-Cordis 插件内核 —— 为 BobWork MCP 模块定制，语义对齐 deepseek-harness 底层的 Cordis 元框架
 *
 * 只做四件事（无特权核心，业务逻辑全部在插件里）：
 *   1. 插件生命周期：Fiber 状态机 pending → loading → active → unloading → disposed（+ error）
 *   2. 可逆副作用：ctx.effect() 注册副作用并收集 disposer，卸载时逆序全部撤销（不留孤儿状态）
 *   3. 服务注册与依赖：provide / getService；插件声明 dependencies，
 *      按拓扑序先挂依赖，依赖缺失则不挂载并记录原因（error）
 *   4. 事件总线：ctx.events.on / emit（支持同步与并发派发）
 *
 * 参考 deepseek-harness/docs/architecture.md：
 *   "Every part of the product is a plugin ... registrations are effects that
 *    unwind when their plugin unloads."（一切皆插件、注册即可逆）
 */

export type Disposer = (() => void) | (() => Promise<void>);

export type PluginState = 'pending' | 'loading' | 'active' | 'error' | 'unloading' | 'disposed';

/** 插件挂载后的运行态快照（供 UI / 诊断展示） */
export interface PluginRuntime {
  id: string;
  name: string;
  state: PluginState;
  error?: string;
  mountedAt: number;
  /** 依赖未满足时列出缺失项 */
  missingDeps?: string[];
}

export interface PluginStateChange {
  id: string;
  state: PluginState;
  error?: string;
}

export interface PluginSpec<TConfig = Record<string, unknown>> {
  /** 插件唯一 id（MCP 场景即 server id） */
  id: string;
  name: string;
  /** 依赖的插件 id；依赖缺失时本插件不挂载（error + missingDeps） */
  dependencies?: string[];
  /**
   * 插件主体：接收 ctx + config，返回 disposer（可逆副作用）。
   * setup 内通过 ctx.effect() 注册的副作用同样在卸载时逆序撤销。
   */
  setup(ctx: PluginContext, config: TConfig): Disposer | void | Promise<Disposer | void>;
}

/** 插件上下文：服务仓库 + 可逆副作用 + 事件总线 */
export class PluginContext {
  readonly id: string;
  readonly name: string;

  constructor(
    private readonly kernel: PluginKernel,
    private readonly fiber: Fiber,
    id: string,
    name: string,
  ) {
    this.id = id;
    this.name = name;
  }

  /**
   * 注册一个可逆副作用（Cordis 语义）：fn 在挂载时立即执行，返回的 disposer 在卸载时撤销。
   * fn 执行顺序即注册顺序；撤销顺序为逆序（保证"可逆性不变量"）。
   */
  effect(fn: () => Disposer | void | Promise<Disposer | void>): void {
    // 立即执行（同步/异步），拿到 disposer 后交给 fiber 在卸载时逆序撤销
    const disposerPromise = Promise.resolve(fn());
    this.fiber.collect(async () => {
      const disposer = await disposerPromise;
      if (typeof disposer === 'function') await disposer();
    });
  }

  /** 获取其它插件提供的服务（依赖注入） */
  getService<T>(name: string): T | undefined {
    return this.kernel.getService<T>(name);
  }

  /** 对外提供服务；本插件卸载时自动移除（可逆） */
  provide(name: string, service: unknown): void {
    this.kernel.provide(name, service, this.id);
    // effect 语义：挂载时注册、返回的 disposer 在卸载时执行 → 正确写法是"返回一个函数"
    this.effect(() => () => {
      this.kernel.unprovide(name, this.id);
    });
  }

  /** 事件总线：订阅（卸载时自动退订） */
  on(event: string, handler: (payload: unknown) => void | Promise<void>): void {
    this.kernel.on(event, handler);
    this.effect(() => () => {
      this.kernel.off(event, handler);
    });
  }

  /** 事件总线：同步派发（按注册顺序，不等待） */
  emit(event: string, payload?: unknown): void {
    this.kernel.emit(event, payload);
  }

  /** 事件总线：并发派发并等待全部完成 */
  async emitParallel(event: string, payload?: unknown): Promise<void> {
    await this.kernel.emitParallel(event, payload);
  }

  logger = {
    info: (msg: string) => console.log(`[plugin:${this.id}] ${msg}`),
    warn: (msg: string) => console.warn(`[plugin:${this.id}] ${msg}`),
    error: (msg: string, err?: unknown) => console.error(`[plugin:${this.id}] ${msg}`, err ?? ''),
  };
}

/** Fiber：一次插件挂载的完整运行时（状态机 + disposer 集合）。非泛型，仅持有规格的结构性子集。 */
class Fiber {
  state: PluginState = 'pending';
  error?: string;
  missingDeps?: string[];
  mountedAt = 0;
  readonly ctx: PluginContext;
  /** 收集到的 disposer（含 setup 返回值与 ctx.effect 注册项），卸载时逆序执行 */
  private disposers: Disposer[] = [];

  constructor(
    readonly spec: { id: string; name: string; dependencies?: string[] },
    readonly config: unknown,
    kernel: PluginKernel,
  ) {
    this.ctx = new PluginContext(kernel, this, spec.id, spec.name);
  }

  /** 记录一个 disposer（卸载时逆序撤销） */
  collect(disposer: Disposer): void {
    this.disposers.push(disposer);
  }

  /** 逆序撤销全部副作用，保证"可逆性不变量" */
  async unwind(): Promise<void> {
    const errors: string[] = [];
    for (let i = this.disposers.length - 1; i >= 0; i--) {
      try {
        await this.disposers[i]();
      } catch (e) {
        errors.push(String(e instanceof Error ? e.message : e));
      }
    }
    this.disposers = [];
    if (errors.length > 0) {
      this.error = `unmount errors: ${errors.join('; ')}`;
    }
  }
}

/**
 * 插件内核：管理 Fiber 生命周期、服务仓库、事件总线。
 * 挂载顺序按 dependencies 拓扑排序；依赖缺失的插件不挂载（error + missingDeps）。
 */
export class PluginKernel {
  private fibers = new Map<string, Fiber>();
  private services = new Map<string, unknown>();
  private serviceOwner = new Map<string, string>();
  private listeners = new Map<string, Array<(payload: unknown) => void | Promise<void>>>();
  private stateChangeHandlers: Array<(change: PluginStateChange) => void> = [];
  private mountSeq: string[] = [];

  /** 挂载一个插件：先校验依赖（必须已 active），再执行 setup，收集 disposer */
  async mount<TConfig>(spec: PluginSpec<TConfig>, config: TConfig): Promise<PluginRuntime> {
    const existing = this.fibers.get(spec.id);
    if (existing && existing.state !== 'disposed') {
      return this.toRuntime(existing);
    }

    const missing: string[] = [];
    for (const depId of spec.dependencies ?? []) {
      const dep = this.fibers.get(depId);
      const depActive = dep && dep.state === 'active';
      if (!depActive) {
        // 依赖在挂载序列中但尚未 active（成环或顺序问题）→ 视为缺失
        missing.push(this.mountSeq.includes(depId) ? `${depId}(not-active/cycle)` : depId);
      }
    }
    if (missing.length > 0) {
      const fiber = new Fiber(spec, config, this);
      fiber.state = 'error';
      fiber.missingDeps = missing;
      fiber.error = `dependency not satisfied: ${missing.join(', ')}`;
      this.fibers.set(spec.id, fiber);
      this.notifyState({ id: spec.id, state: 'error', error: fiber.error });
      return this.toRuntime(fiber);
    }

    const fiber = new Fiber(spec, config, this);
    this.fibers.set(spec.id, fiber);
    this.mountSeq.push(spec.id);
    fiber.state = 'loading';
    this.notifyState({ id: spec.id, state: 'loading' });

    try {
      const result = await spec.setup(fiber.ctx, config);
      if (typeof result === 'function') fiber.collect(result);
      fiber.state = 'active';
      fiber.mountedAt = Date.now();
      this.notifyState({ id: spec.id, state: 'active' });
    } catch (e) {
      fiber.state = 'error';
      fiber.error = e instanceof Error ? e.message : String(e);
      // 出错也逆序撤销已注册的副作用，避免残留
      await fiber.unwind();
      this.notifyState({ id: spec.id, state: 'error', error: fiber.error });
    }
    return this.toRuntime(fiber);
  }

  /** 卸载插件：逆序撤销全部副作用 → disposed */
  async unmount(id: string): Promise<void> {
    const fiber = this.fibers.get(id);
    if (!fiber || fiber.state === 'disposed') return;
    fiber.state = 'unloading';
    this.notifyState({ id, state: 'unloading' });
    await fiber.unwind();
    fiber.state = 'disposed';
    this.mountSeq = this.mountSeq.filter((m) => m !== id);
    this.notifyState({ id, state: 'disposed' });
  }

  /**
   * 按配置协调插件集合：卸载已移除/需重启的，挂载新增/缺失的。
   * 返回变更后的全部运行态。
   */
  async reconcile<TConfig>(
    specs: Array<PluginSpec<TConfig>>,
    configs: Map<string, TConfig>,
    changedIds: Set<string>,
  ): Promise<PluginRuntime[]> {
    const specIds = new Set(specs.map((s) => s.id));
    // 1) 卸载：已不存在于配置 / 配置变更需重启
    for (const [id, fiber] of this.fibers) {
      if (fiber.state === 'disposed') continue;
      if (!specIds.has(id) || changedIds.has(id)) {
        await this.unmount(id);
      }
    }
    // 2) 挂载新增或重启的
    for (const spec of specs) {
      const cur = this.fibers.get(spec.id);
      if (!cur || cur.state === 'disposed') {
        await this.mount(spec, configs.get(spec.id) as TConfig);
      }
    }
    return this.getAllRuntimes();
  }

  /** 插件当前运行态快照 */
  toRuntime(fiber: Fiber): PluginRuntime {
    return {
      id: fiber.spec.id,
      name: fiber.spec.name,
      state: fiber.state,
      error: fiber.error,
      mountedAt: fiber.mountedAt,
      missingDeps: fiber.missingDeps,
    };
  }

  getRuntime(id: string): PluginRuntime | undefined {
    const f = this.fibers.get(id);
    return f ? this.toRuntime(f) : undefined;
  }

  getAllRuntimes(): PluginRuntime[] {
    return [...this.fibers.values()].map((f) => this.toRuntime(f));
  }

  /** 处于 active 的插件 id 集合 */
  activeIds(): Set<string> {
    return new Set([...this.fibers.values()].filter((f) => f.state === 'active').map((f) => f.spec.id));
  }

  // ---- 服务仓库 ----
  provide(name: string, service: unknown, ownerId: string): void {
    if (this.serviceOwner.has(name) && this.serviceOwner.get(name) !== ownerId) {
      throw new Error(`[kernel] service "${name}" already provided by ${this.serviceOwner.get(name)}`);
    }
    this.services.set(name, service);
    this.serviceOwner.set(name, ownerId);
  }

  unprovide(name: string, ownerId: string): void {
    if (this.serviceOwner.get(name) !== ownerId) return;
    this.services.delete(name);
    this.serviceOwner.delete(name);
  }

  getService<T>(name: string): T | undefined {
    return this.services.get(name) as T | undefined;
  }

  // ---- 事件总线 ----
  on(event: string, handler: (payload: unknown) => void | Promise<void>): void {
    const list = this.listeners.get(event) ?? [];
    list.push(handler);
    this.listeners.set(event, list);
  }

  off(event: string, handler: (payload: unknown) => void | Promise<void>): void {
    const list = this.listeners.get(event);
    if (!list) return;
    this.listeners.set(event, list.filter((h) => h !== handler));
  }

  emit(event: string, payload?: unknown): void {
    for (const h of this.listeners.get(event) ?? []) {
      void h(payload);
    }
  }

  async emitParallel(event: string, payload?: unknown): Promise<void> {
    await Promise.all((this.listeners.get(event) ?? []).map((h) => h(payload)));
  }

  /** 订阅插件状态变化（UI / 诊断用）；返回退订函数 */
  onStateChange(handler: (change: PluginStateChange) => void): () => void {
    this.stateChangeHandlers.push(handler);
    return () => {
      this.stateChangeHandlers = this.stateChangeHandlers.filter((h) => h !== handler);
    };
  }

  private notifyState(change: PluginStateChange): void {
    for (const h of this.stateChangeHandlers) h(change);
  }
}
