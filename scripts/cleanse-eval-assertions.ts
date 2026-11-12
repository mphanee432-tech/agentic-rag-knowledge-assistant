import { readFileSync } from "node:fs"
import { validateGoldenDataset } from "../lib/eval-dataset"

// Legacy assertion rewriting corrupted the flat canonical dataset; validate it without mutation.
const dataset: unknown = JSON.parse(readFileSync("evals/golden_dataset.json", "utf8"))
validateGoldenDataset(dataset)
console.log("Golden dataset schema and 50-case allocation are valid. Use eval:prepare to generate Promptfoo assertions.")
