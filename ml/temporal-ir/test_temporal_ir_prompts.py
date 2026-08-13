import unittest
from pathlib import Path

from temporal_ir_prompts import PROMPT_PRESETS, compact_plan, compact_step, format_chat_user_content, format_prompt


ROW = {
    "input": {
        "text": "tomorrow at noon",
        "referenceInstant": "2026-08-03T12:00:00.000Z",
        "timeZone": "America/Indianapolis",
    }
}


class PromptPresetTests(unittest.TestCase):
    def test_none_custom_prompt_has_only_the_input_envelope(self) -> None:
        prompt = format_prompt(ROW, "none")

        self.assertNotIn("### Instruction:", prompt)
        self.assertTrue(prompt.startswith("### Input:\n"))
        self.assertTrue(prompt.endswith("\n\n### Response:\n"))

    def test_none_chat_content_has_only_the_input_envelope(self) -> None:
        content = format_chat_user_content(ROW, "none")

        self.assertTrue(content.startswith("Input:\n"))
        self.assertNotIn("Translate", content)

    def test_minimal_prompt_keeps_the_existing_serialization(self) -> None:
        prompt = format_prompt(ROW, "minimal")

        self.assertTrue(prompt.startswith("### Instruction:\nTranslate the temporal user input"))

    def test_typescript_runtime_and_eval_prompts_match_python_presets(self) -> None:
        repo_root = Path(__file__).resolve().parents[2]
        for relative_path in ["api/src/temporal/graph.ts", "api/scripts/temporal-model-eval.ts"]:
            source = (repo_root / relative_path).read_text(encoding="utf-8")
            for preset in ["minimal", "detailed"]:
                self.assertIn(f"{preset}: '{PROMPT_PRESETS[preset]}'", source, f"{relative_path} {preset} prompt drifted")

    def test_compact_plan_preserves_explicit_presentation_format(self) -> None:
        compact = compact_plan({"label": "Shifted timestamp", "presentationFormat": "f", "steps": []})

        self.assertEqual(compact["format"], "f")

    def test_compact_step_preserves_bounded_clock_options(self) -> None:
        options = [
            {"label": "2 AM", "text": "2 am"},
            {"label": "2 PM", "text": "2 pm"},
        ]
        compact = compact_step({"operation": "resolve_clock_time", "options": options})

        self.assertEqual(compact["options"], options)


if __name__ == "__main__":
    unittest.main()
