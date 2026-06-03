export const buildPositionWorkWeights = (positionCount: number): number[] => {
  if (positionCount <= 1) return [1];

  const weights: number[] = [];
  const mu = 0.5;
  const sigma = 0.22;
  const minWeight = 0.4;

  for (let index = 0; index < positionCount; index++) {
    const t = index / (positionCount - 1);
    const bell = Math.exp(-0.5 * Math.pow((t - mu) / sigma, 2));
    weights.push(minWeight + (1 - minWeight) * bell);
  }

  return weights;
};

export const getPendingWorkWeight = (
  pendingIndices: number[],
  positionWeights: number[]
): number => {
  return pendingIndices.reduce((sum, index) => sum + positionWeights[index], 0);
};

export const assignIndicesToLanesByWorkWeight = (
  indices: number[],
  laneCount: number,
  positionWeights: number[]
): number[][] => {
  const lanes: number[][] = Array.from({ length: laneCount }, () => []);
  const laneLoads = new Array(laneCount).fill(0);

  const sortedIndices = [...indices].sort(
    (a, b) => positionWeights[b] - positionWeights[a]
  );

  for (const index of sortedIndices) {
    let lightestLane = 0;
    for (let laneId = 1; laneId < laneCount; laneId++) {
      if (laneLoads[laneId] < laneLoads[lightestLane]) {
        lightestLane = laneId;
      }
    }

    lanes[lightestLane].push(index);
    laneLoads[lightestLane] += positionWeights[index];
  }

  for (const lane of lanes) {
    lane.sort((a, b) => a - b);
  }

  return lanes.filter((lane) => lane.length > 0);
};
