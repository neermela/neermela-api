// AI provider abstraction (spec §41). Swap via AI_PROVIDER. Powers NeerMela AI.
import { config } from '../../config/index.js';
const providers = {
  mock: { async chat({ prompt }) { return { text: `NeerMela AI (demo): you said "${prompt}". Connect Gemini in AI_PROVIDER for real answers.`, provider: 'mock' }; } },
  gemini: {
    async chat() {
      // const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key='+process.env.AI_PROVIDER_SECRET, {...});
      throw new Error('Gemini adapter not configured. Set AI_PROVIDER_SECRET and implement chat().');
    },
  },
};
export const ai = { chat(args) { return (providers[config.providers.ai] || providers.mock).chat(args); } };
