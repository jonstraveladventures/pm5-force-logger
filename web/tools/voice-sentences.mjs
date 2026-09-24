// Prints every sentence the recorded voice should hold, as JSON [{id, text}], for make_voice.py.
import { allSentences, clipId } from "../voice.js";
console.log(JSON.stringify(allSentences().map(text => ({ id: clipId(text), text }))));
