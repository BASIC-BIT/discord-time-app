from __future__ import annotations

import threading
import time
import unittest

from serve_peft_openai import GenerationCancelled, ServerState, generate_locked


class FakeGenerator:
    def generate(self, prompt, *, max_new_tokens, temperature, cancel_event):
        while not cancel_event.is_set():
            time.sleep(0.005)
        return object()


class CancellationTests(unittest.TestCase):
    def make_state(self) -> ServerState:
        return ServerState(
            generator=FakeGenerator(),
            model_name="test",
            default_max_new_tokens=8,
            auth_token=None,
            prompt_format="custom",
            enable_thinking=False,
        )

    def test_queued_generation_cancels_without_acquiring_gpu_lock(self):
        state = self.make_state()
        state.lock.acquire()
        cancel_event = threading.Event()
        errors = []

        def run():
            try:
                generate_locked(
                    state,
                    "queued",
                    max_new_tokens=8,
                    temperature=0,
                    cancel_event=cancel_event,
                )
            except Exception as error:
                errors.append(error)

        worker = threading.Thread(target=run)
        worker.start()
        cancel_event.set()
        worker.join(timeout=1)
        state.lock.release()
        self.assertFalse(worker.is_alive())
        self.assertIsInstance(errors[0], GenerationCancelled)

    def test_active_generation_observes_cancellation(self):
        state = self.make_state()
        cancel_event = threading.Event()
        errors = []

        def run():
            try:
                generate_locked(
                    state,
                    "active",
                    max_new_tokens=8,
                    temperature=0,
                    cancel_event=cancel_event,
                )
            except Exception as error:
                errors.append(error)

        worker = threading.Thread(target=run)
        worker.start()
        time.sleep(0.02)
        cancel_event.set()
        worker.join(timeout=1)
        self.assertFalse(worker.is_alive())
        self.assertIsInstance(errors[0], GenerationCancelled)


if __name__ == "__main__":
    unittest.main()
