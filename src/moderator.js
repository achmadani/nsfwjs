const path = require('path');
const tf = require('@tensorflow/tfjs-node');
const nsfwjs = require('nsfwjs');

// Kelas yang dianggap NSFW, dengan default threshold per kategori.
// Porn/Hentai dibuat ketat karena false negative lebih mahal.
// Sexy dibuat longgar karena kelas ini paling noisy (pakaian minim, pose biasa).
const DEFAULT_THRESHOLDS = {
  Porn: 0.3,
  Hentai: 0.3,
  Sexy: 0.8
};

function resolveThresholds() {
  const fallback = Number(process.env.NSFW_THRESHOLD);
  return Object.fromEntries(Object.entries(DEFAULT_THRESHOLDS).map(([className, defaultValue]) => {
    const specific = Number(process.env[`NSFW_THRESHOLD_${className.toUpperCase()}`]);
    if (Number.isFinite(specific)) return [className, specific];
    if (Number.isFinite(fallback)) return [className, fallback];
    return [className, defaultValue];
  }));
}

class Moderator {
  constructor() {
    this.model = null;
    this.loading = null;
    this.modelPath = process.env.NSFW_MODEL_PATH || undefined;
    this.thresholds = resolveThresholds();
  }

  async load() {
    if (this.model) return this.model;
    if (!this.loading) {
      const source = this.modelPath ? path.resolve(this.modelPath) : undefined;
      this.loading = nsfwjs.load(source).then((model) => {
        this.model = model;
        return model;
      });
    }
    return this.loading;
  }

  isReady() {
    return Boolean(this.model);
  }

  tensorMemory() {
    return tf.memory();
  }

  async classify(buffer) {
    const model = await this.load();
    let imageTensor;
    try {
      imageTensor = tf.node.decodeImage(buffer, 3);
      const predictions = await model.classify(imageTensor);
      const scores = Object.fromEntries(predictions.map(({ className, probability }) => [className, probability]));
      const flagged = predictions.filter(({ className, probability }) => (
        className in this.thresholds && probability >= this.thresholds[className]
      ));

      return {
        is_nsfw: flagged.length > 0,
        thresholds: this.thresholds,
        predictions,
        scores,
        flagged_categories: flagged.map(({ className, probability }) => ({
          category: className,
          probability,
          threshold: this.thresholds[className]
        }))
      };
    } finally {
      if (imageTensor) imageTensor.dispose();
    }
  }
}

module.exports = Moderator;
