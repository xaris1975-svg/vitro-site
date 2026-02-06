// public/contact.js
// Connects your contact form to /api/contact (server.js)

(function () {
  function val(id) {
    const el = document.getElementById(id);
    return el ? (el.value || "").trim() : "";
  }

  async function submitContact(e) {
    e.preventDefault();

    const payload = {
      name: val("contactName"),
      email: val("contactEmail"),
      message: val("contactMessage"),
    };

    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data?.error || `HTTP ${res.status}`);
      }

      if (typeof window.showToast === "function") window.showToast("✅ Το μήνυμα στάλθηκε!");
      else alert("Το μήνυμα στάλθηκε!");

      if (e.target && typeof e.target.reset === "function") e.target.reset();
      if (typeof window.closeModal === "function") window.closeModal();
    } catch (err) {
      console.error("CONTACT ERROR:", err);
      if (typeof window.showToast === "function") window.showToast("❌ Δεν στάλθηκε. Δοκίμασε ξανά.");
      else alert("Δεν στάλθηκε. Δοκίμασε ξανά.");
    }
  }

  window.attachContactForm = function (formId) {
    const form = document.getElementById(formId);
    if (!form) return;
    form.addEventListener("submit", submitContact);
  };
})();
