export class AnalysisProgressTracker {
  /** Engine/cloud phase tops out here; classification uses the last 1%. */
  static readonly ENGINE_PHASE_MAX = 99;

  private readonly positionCount: number;
  private readonly targetDepth: number;
  private readonly laneDepths = new Map<
    number,
    { index: number; depth: number }
  >();
  private readonly completedIndices = new Set<number>();
  private maxProgress = 1;
  private lastEmitAt = 0;
  private lastProgressUnits = 0;

  constructor(
    positionCount: number,
    targetDepth: number,
    private readonly onProgress: (value: number) => void
  ) {
    this.positionCount = positionCount;
    this.targetDepth = targetDepth;
  }

  setLaneDepth(laneId: number, index: number, depth: number) {
    this.laneDepths.set(laneId, {
      index,
      depth: Math.min(Math.max(depth, 0), this.targetDepth),
    });
    this.emit(false);
  }

  markComplete(index: number, laneId: number) {
    this.completedIndices.add(index);
    if (laneId >= 0) {
      const lane = this.laneDepths.get(laneId);
      if (lane?.index === index) {
        this.laneDepths.delete(laneId);
      }
    }
    this.emit(true);
  }

  getProgress(): number {
    return this.maxProgress;
  }

  private computeProgressUnits(): number {
    let progressUnits = this.completedIndices.size;

    for (const { index, depth } of this.laneDepths.values()) {
      if (this.completedIndices.has(index)) continue;
      progressUnits += depth / this.targetDepth;
    }

    return progressUnits;
  }

  private emit(force: boolean) {
    const progressUnits = this.computeProgressUnits();
    const now = performance.now();
    const depthAdvanced = progressUnits > this.lastProgressUnits + 0.001;

    if (!force && !depthAdvanced && now < this.lastEmitAt + 16) return;

    this.lastEmitAt = now;
    this.lastProgressUnits = progressUnits;

    const progressPercent = Math.min(
      AnalysisProgressTracker.ENGINE_PHASE_MAX,
      (progressUnits / this.positionCount) *
        AnalysisProgressTracker.ENGINE_PHASE_MAX
    );
    this.maxProgress = Math.max(this.maxProgress, progressPercent);
    this.onProgress(this.maxProgress);
  }

  setPhaseProgress(percent: number) {
    this.maxProgress = Math.max(this.maxProgress, Math.min(100, percent));
    this.onProgress(this.maxProgress);
  }
}
