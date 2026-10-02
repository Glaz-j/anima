"""Check attribution and missing-time behavior with original fictional fixtures."""

import unittest

from prepare_synthetic_persona_chat import adapt_messages, build_examples, parse_conversation, validate_view


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.turns, issues = parse_conversation(
            "User 1: Hello.\nUser 2: What do you enjoy?\nUser 1: Drawing.\nUser 2: Me too."
        )
        self.assertEqual(issues, [])

    def test_each_target_gets_their_own_assistant_role(self):
        for target in (1, 2):
            records = adapt_messages("synthetic", 1, self.turns, target)
            examples = build_examples(records)
            validate_view(records, examples)
            for example in examples:
                mid = example["target_message_ids"][0]
                original = next(record for record in records if record["message_id"] == mid)
                self.assertEqual(original["sender_id"], original["account_id"])
                self.assertEqual(example["messages"][-1], {"role": "assistant", "content": original["text"]})
            self.assertEqual(len(examples), 1 if target == 1 else 2)

    def test_user_one_is_not_a_global_identity(self):
        first = adapt_messages("synthetic", 1, self.turns, 1)
        second = adapt_messages("synthetic", 2, self.turns, 1)
        self.assertNotEqual(first[0]["account_id"], second[0]["account_id"])
        self.assertNotEqual(first[0]["message_id"], second[0]["message_id"])

    def test_unknown_time_is_not_fabricated(self):
        records = adapt_messages("synthetic", 1, self.turns, 1)
        self.assertEqual([record["sort_sequence"] for record in records], [1, 2, 3, 4])
        for record in records:
            for field in ("timestamp", "timestamp_ms", "time_iso"):
                self.assertIsNone(record[field])

    def test_unlabelled_text_requires_review(self):
        for extra in ("[later]", "An unlabelled continuation.", "**User 2: Decorated speaker.**"):
            _, issues = parse_conversation(f"User 1: Hi.\n{extra}\nUser 2: Hello.")
            self.assertEqual(issues[0]["reason"], "unrecognized_speaker_or_narration")
        for value in ("", "User 1: Hi.", "User 1:\nUser 2: Hello."):
            self.assertTrue(parse_conversation(value)[1])

    def test_speaker_mention_inside_text_is_not_a_new_turn(self):
        turns, issues = parse_conversation('User 1: I read "User 2: hello".\n\nUser 2: Okay.')
        self.assertEqual(issues, [])
        self.assertEqual(len(turns), 2)
        self.assertEqual(turns[0]["text"], 'I read "User 2: hello".')
        self.assertEqual(turns[1]["line_in_cell"], 3)

    def test_context_is_bounded_and_excludes_future_turns(self):
        turns = [{"speaker": 1 + i % 2, "text": str(i), "line_in_cell": i + 1} for i in range(20)]
        records = adapt_messages("test", 8, turns, 2)
        examples = build_examples(records)
        validate_view(records, examples)
        self.assertEqual(len(examples[-1]["context_message_ids"]), 8)
        self.assertEqual(examples[-1]["messages"][-1]["content"], "19")
        self.assertEqual(examples[-1]["messages"][0]["content"], "11")


if __name__ == "__main__":
    unittest.main()
