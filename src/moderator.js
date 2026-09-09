const path = require('path');
const tf = require('@tensorflow/tfjs-node');
const nsfwjs = require('nsfwjs');

const BLOCKED_LABELS = new Set(['Porn', 'Hentai', 'Sexy']);

class Moderator {
  constructor() {
    this.model = null;
    this.loading = null;
    this.modelPath = process.env.NSFW_MODEL_PATH || undefined;
    this.threshold = Number(process.env.NSFW_THRESHOLD || 0.5);
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

  async classify(buffer) {
    const model = await this.load();
    let imageTensor;
    try {
      imageTensor = tf.node.decodeImage(buffer, 3);
      const predictions = await model.classify(imageTensor);
      const scores = Object.fromEntries(predictions.map(({ className, probability }) => [className, probability]));
      const flagged = predictions.filter(({ className, probability }) => (
        BLOCKED_LABELS.has(className) && probability >= this.threshold
      ));

      return {
        is_nsfw: flagged.length > 0,
        threshold: this.threshold,
        predictions,
        scores,
        flagged_categories: flagged.map(({ className, probability }) => ({
          category: className,
          probability
        }))
      };
    } finally {
      if (imageTensor) imageTensor.dispose();
    }
  }
}

module.exports = Moderator;
