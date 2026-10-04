/* ============================================================================
 * src/core/rebuilder.js · ⑧Clear —— 全工程唯一清理出口
 * ----------------------------------------------------------------------------
 * 铁律（方案 §2 第 4 条）：只有 `Rebuilder.clear(root|null)` 一个入口，
 *   且**缓存清理必须与该函数写在同一个函数体内**（对称、不可分离）。
 *   禁止任何新代码自建清理路径（旧版 3 个清理出口 + 外置 helper 各自清缓存，R3/R4）。
 *
 * 需要与视觉清理同生共死的缓存清单（旧版逐条踩过坑）：
 *   · comboLR 的 `_cellVerified`  —— 左右格"已处理"缓存
 *   · comboTB 的 `_tbColProcessed` —— 上下格"已处理"缓存
 *   · contentKey 指纹缓存 / 统计去重表
 *   · Renderer 的 Range 缓存（h._range）与 highlight 组
 *   · Retry/Pending 队列（值后到的重试计划）
 *   —— 任一项漏清 → el-table 复用同一批 td 时被 stale 缓存跳过 → 永不恢复（ST-06）。
 *
 * root 语义：
 *   · `clear(root)` 传具体节点 → 局部清理（仅移除该子树内的命中与缓存）
 *   · `clear(null)`           → 全量清理（destroy / 切标签 / 插件停用）
 * ========================================================================= */

(function () {
  'use strict';

  const KH = (typeof window !== 'undefined' ? (window.KH = window.KH || {}) : (globalThis.KH = globalThis.KH || {}));

  const Rebuilder = {
    /** 组合词缓存（唯一实例，禁止别处再 new） */
    caches: {
      /** lr：键 = ruleId + '|' + 左格指纹；值 = 已验证结果（命中才缓存） */
      cellVerified: new Map(),
      /** tb：键 = ruleId + '|' + 列指纹；值 = true */
      tbColProcessed: new Map(),
      /** 统计去重：contentKey -> true（R6 / UN-09） */
      statDedup: new Set(),
      /** 值后到重试计划：{ id -> {tries, timer} } */
      retry: new Map()
    },

    /** 本次重建期间的重试计划登记（scheduler 在 rebuild 前清空、rebuild 后重排） */
    _rebuildLockDepth: 0,

    /** 是否处于重建抑制窗口内（observer 回调据此 return，不做 DOM 形态过滤） */
    get inRebuildWindow() { return this._rebuildLockDepth > 0; },

    /**
     * 唯一的清理出口。
     * @param {Node|null} root
     * @param {{visual?: boolean, registry?: boolean, reason?: string}} [opts]
     *   opts.visual   —— 是否清视觉（默认 true）
     *   opts.registry —— 是否清命中表（默认清；局部清理时只清 root 内的）
     *   opts.reason   —— 触发原因：'rebuild'（每次重建前的清底）/ 'destroy'（全量下线）
     *                    features 的 clear(root, {reason}) 据此区分"重建前清底"与"彻底拆除"：
     *                    前者应保留宿主外壳（避免闪一下白），后者必须连宿主一起移除。
     */
    clear(root, opts) {
      const o = Object.assign({ visual: true, registry: true, reason: 'rebuild' }, opts || {});

      /* ---- ① 视觉 ---- */
      if (o.visual && KH.Renderer) {
        // 局部清理：只撤销 root 内的 Range（避免误伤其它子树）
        if (root) {
          if (KH.Renderer._groups && KH.Renderer._groups.size) {
            for (const [name, hl] of Array.from(KH.Renderer._groups.entries())) {
              const keep = [];
              for (const r of hl) {
                const n = r.startContainer;
                if (n && root.contains && root.contains(n)) continue; // 丢弃本次要清的
                keep.push(r);
              }
              // 必须走 Renderer.setGroup —— 全库唯一允许碰 CSS.highlights 的地方（meta-check #5）
              KH.Renderer.setGroup(name, keep);
            }
          }
        } else {
          KH.Renderer.clear();
        }
      }

      /* ---- ② 命中表 ---- */
      if (o.registry && KH.registry) {
        if (!root) {
          KH.registry.clear();
        } else {
          for (const h of KH.registry.all()) {
            const n = h.textNode;
            if (!n || !n.isConnected || (root.contains && root.contains(n))) KH.registry.remove(h.id);
          }
        }
      }

      /* ---- ③ 缓存（与上面必须同函数体，禁止外置） ---- */
      const c = this.caches;
      const clearAll = !root;
      if (clearAll) {
        c.cellVerified.clear();
        c.tbColProcessed.clear();
        c.statDedup.clear();
        for (const [, job] of c.retry) { if (job && job.timer) clearTimeout(job.timer); }
        c.retry.clear();
      } else {
        // 局部清理：按键前缀无法判定归属，采用"保守全清 + 让扫描重建"策略。
        // 理由：缓存是"性能优化 + 结果缓存"，全清只会多算一次，多算不会错；漏清则会永久卡死。
        c.cellVerified.clear();
        c.tbColProcessed.clear();
      }

      /* ---- ④ feature 侧清理钩子（统一注册，禁止各自监听 rebuild） ---- */
      if (KH.features && KH.features.entries) {
        for (const [label, feat] of KH.features.entries()) {
          if (!feat || typeof feat.clear !== 'function') continue;
          try { feat.clear(root, o); } catch (err) { console.error('[KH] feature clear 异常:', label, err); }
        }
      }
    },

    /** 重建抑制窗口：用 try/finally 保证成对解开（旧版 `_rebuilding` + setTimeout 双保险） */
    enterRebuild() { this._rebuildLockDepth++; },
    exitRebuild(delayMs) {
      const unlock = () => { this._rebuildLockDepth = Math.max(0, this._rebuildLockDepth - 1); };
      if (delayMs && delayMs > 0) setTimeout(unlock, delayMs);
      else unlock();
    }
  };

  KH.Rebuilder = Rebuilder;
})();
