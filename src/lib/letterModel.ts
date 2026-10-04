/**
 * Browser inference for the reused pretrained letter MLP (Ahmed7610/real-time-asl-recognition, MIT).
 * Weights are exported to JSON with BatchNorm + StandardScaler folded into the dense layers, so
 * inference is 4 dense layers: relu, relu, relu, softmax. Pure, no DOM.
 */

export type Candidate = { v: string; p: number };

export type MlpLayer = { in: number; out: number; w: number[]; b: number[]; act: "relu" | "softmax" };
export type MlpJson = { labels: string[]; layers: MlpLayer[]; source?: string };

export type Classifier = {
  labels: string[];
  /** probability per label, same order as `labels` */
  predict: (features: readonly number[]) => number[];
};

export function createMlp(json: MlpJson): Classifier {
  const layers = json.layers.map((l) => ({ ...l, w: Float32Array.from(l.w), b: Float32Array.from(l.b) }));
  if (layers[layers.length - 1].out !== json.labels.length) throw new Error("label count mismatch");
  return {
    labels: json.labels,
    predict(features) {
      let x: Float32Array = Float32Array.from(features);
      for (const l of layers) {
        if (x.length !== l.in) throw new Error(`expected ${l.in} inputs, got ${x.length}`);
        const y = new Float32Array(l.out);
        for (let j = 0; j < l.out; j++) y[j] = l.b[j];
        // w is row-major [in][out]
        for (let i = 0; i < l.in; i++) {
          const xi = x[i];
          if (xi === 0) continue;
          const row = i * l.out;
          for (let j = 0; j < l.out; j++) y[j] += xi * l.w[row + j];
        }
        if (l.act === "relu") {
          for (let j = 0; j < l.out; j++) if (y[j] < 0) y[j] = 0;
        } else {
          softmaxInPlace(y);
        }
        x = y;
      }
      return Array.from(x);
    },
  };
}

export function softmaxInPlace(y: Float32Array | number[]): void {
  let max = -Infinity;
  for (const v of y) if (v > max) max = v;
  let sum = 0;
  for (let j = 0; j < y.length; j++) {
    y[j] = Math.exp(y[j] - max);
    sum += y[j];
  }
  for (let j = 0; j < y.length; j++) y[j] /= sum;
}

/** Top-k labels by probability, descending. */
export function topK(labels: readonly string[], probs: readonly number[], k = 3): Candidate[] {
  return probs
    .map((p, i) => ({ v: labels[i], p }))
    .sort((a, b) => b.p - a.p)
    .slice(0, k);
}

export async function loadLetterModel(url = "/models/letter-mlp.json"): Promise<Classifier> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`letter model: HTTP ${res.status}`);
  return createMlp((await res.json()) as MlpJson);
}
