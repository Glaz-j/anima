"""Protect identity boundaries in fictional-character material preparation."""

import tempfile
import unittest
from pathlib import Path

from inspect_cped import character_id, inspect, normalized


class CharacterIdentityTests(unittest.TestCase):
    def row(self, speaker="甲"):
        return {"TV_ID": "1", "Dialogue_ID": "01_002", "Utterance_ID": "01_002_003",
                "Speaker": speaker, "Utterance": "这是一条原创测试台词。", "_file": "test.csv", "_row": 4,
                "_split": "test", "Emotion": "happy", "Neuroticism": "high"}

    def test_same_name_in_different_tv_ids_remains_separate(self):
        self.assertNotEqual(character_id("1", "同名人物"), character_id("2", "同名人物"))
        self.assertEqual(character_id("01", "同名人物"), character_id("1", "同名人物"))

    def test_multiple_peers_keep_distinct_senders(self):
        participants = {"甲", "乙", "丙"}
        first = normalized(self.row("乙"), ("1", "甲"), participants)
        second = normalized(self.row("丙"), ("1", "甲"), participants)
        self.assertNotEqual(first["sender_id"], second["sender_id"])
        self.assertFalse(first["is_self"])
        self.assertFalse(second["is_self"])
        self.assertTrue(first["is_group"])
        self.assertNotIn("Emotion", first["source"])
        self.assertNotIn("Neuroticism", first["source"])

    def test_grouped_other_does_not_become_a_person(self):
        record = normalized(self.row("其他"), ("1", "甲"), {"甲", "其他"})
        self.assertIsNone(record["sender_id"])
        self.assertFalse(record["is_self"])
        self.assertTrue(record["source"]["speaker_is_grouped"])
        self.assertTrue(record["source"]["participant_count_is_lower_bound"])
        self.assertIsNone(record["timestamp"])

    def test_grouped_target_rejected_before_download(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            with self.assertRaisesRegex(ValueError, "Grouped"):
                inspect(root, root / "output", [("1", "其他")])
            self.assertFalse((root / "raw").exists())


if __name__ == "__main__":
    unittest.main()
