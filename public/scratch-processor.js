class RadioScratchProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{
      name: "speed",
      defaultValue: 0,
      minValue: -12,
      maxValue: 12,
      automationRate: "a-rate",
    }];
  }

  constructor() {
    super();
    this.channels = [];
    this.sourceSampleRate = sampleRate;
    this.position = 0;
    this.active = false;
    this.level = 0;
    this.smoothedSpeed = 0;
    this.port.onmessage = ({ data }) => {
      if (data.type === "buffer") {
        this.channels = data.channels;
        this.sourceSampleRate = data.sampleRate;
        this.position = 0;
      } else if (data.type === "clear") {
        this.channels = [];
        this.position = 0;
        this.active = false;
        this.level = 0;
        this.smoothedSpeed = 0;
      } else if (data.type === "seek") {
        this.position = Math.max(0, data.time * this.sourceSampleRate);
      } else if (data.type === "active") {
        this.active = data.value;
      }
    };
  }

  process(_inputs, outputs, parameters) {
    const output = outputs[0];
    if (!output?.length) return true;
    const speedValues = parameters.speed;
    const frameLength = this.channels[0]?.length || 0;
    const sourceStep = this.sourceSampleRate / sampleRate;

    for (let frame = 0; frame < output[0].length; frame += 1) {
      const targetSpeed = speedValues.length === 1 ? speedValues[0] : speedValues[frame];
      this.smoothedSpeed += (targetSpeed - this.smoothedSpeed) * 0.16;
      const targetLevel = this.active ? Math.min(1, Math.abs(this.smoothedSpeed) * 0.9) : 0;
      this.level += (targetLevel - this.level) * 0.035;

      if (this.level < 0.0001 || frameLength < 2 || this.position < 0 || this.position >= frameLength - 1) {
        for (let channel = 0; channel < output.length; channel += 1) output[channel][frame] = 0;
        continue;
      }

      const lower = Math.floor(this.position);
      const blend = this.position - lower;
      for (let channel = 0; channel < output.length; channel += 1) {
        const input = this.channels[Math.min(channel, this.channels.length - 1)];
        const sample = input[lower] + (input[lower + 1] - input[lower]) * blend;
        output[channel][frame] = Math.tanh(sample * 1.12) * this.level;
      }
      this.position += this.smoothedSpeed * sourceStep;
    }
    return true;
  }
}

registerProcessor("radio-scratch-processor", RadioScratchProcessor);
