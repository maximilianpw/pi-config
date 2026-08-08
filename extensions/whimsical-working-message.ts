import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const WHIMSICAL_WORKING_MESSAGES = [
  "Recombobulating...",
  "Noodling...",
  "Percolating...",
  "Pondering...",
  "Tinkering...",
  "Wrangling...",
  "Spelunking...",
  "Cogitating...",
  "Ruminating...",
  "Finagling...",
  "Sleuthing...",
  "Synthesizing...",
  "Tokenmaxxing...",
  "Reticulating splines...",
  "Consulting the rubber duck...",
  "Bribing the compiler...",
  "Negotiating with entropy...",
  "Whispering to the bits...",
  "Tickling the stack...",
  "Massaging the heap...",
  "Herding pointers...",
  "Polishing the algorithms...",
  "Consulting ancient scrolls...",
  "Shaking the magic 8-ball...",
  "Communing with the machine spirit...",
  "Performing arcane rituals...",
  "Scrying the codebase...",
  "Shuffling bits around...",
  "Calibrating the flux capacitor...",
  "Politely asking the CPU...",
  "Having words with the cache...",
  "Interrogating the stack trace...",
  "Giving the code a pep talk...",
  "Greasing the gears...",
  "Watering the logic tree...",
  "Pruning the decision branches...",
  "Teaching old code new tricks...",
  "Dancing with dependencies...",
  "Tangoing with type errors...",
  "Convincing the pixels to cooperate...",
  "Hypnotizing the hash tables...",
  "Exorcising the exceptions...",
  "Untying the type knots...",
  "Unearthing buried bugs...",
  "Seasoning the solution...",
  "Convincing the linter to chill...",
  "Apologizing to the type checker...",
  "Making illegal states unrepresentable...",
] as const;

export function pickWhimsicalWorkingMessage(random = Math.random): string {
  return WHIMSICAL_WORKING_MESSAGES[
    Math.floor(random() * WHIMSICAL_WORKING_MESSAGES.length)
  ]!;
}

export default function whimsicalWorkingMessage(pi: ExtensionAPI): void {
  pi.on("turn_start", (_event, ctx) => {
    ctx.ui.setWorkingMessage(pickWhimsicalWorkingMessage());
  });

  pi.on("turn_end", (_event, ctx) => {
    ctx.ui.setWorkingMessage();
  });
}
