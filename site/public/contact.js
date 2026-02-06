// Sends the contact + quote forms to /api/contact.
// Works even if the HTML has inline onsubmit handlers, by listening in CAPTURE phase.
(function () {
  function toast(msg) {
    try {
      if (typeof window.showToast === "function") return window.showToast(msg);
    } catch {}
    alert(msg);
  }

  function pickValue(el) {
    return (el && typeof el.value === "string") ? el.value.trim() : "";
  }

  function findByLabel(form, labelText) {
    const labels = Array.from(form.querySelectorAll("label"));
    const label = labels.find(l => (l.textContent || "").toLowerCase().includes(labelText));
    if (!label) return null;
    const input = label.querySelector("input, textarea, select");
    if (input) return input;
    // try next element
    const next = label.nextElementSibling;
    if (next && next.matches("input, textarea, select")) return next;
    return null;
  }

  function isContactLike(form) {
    const hasEmail = !!form.querySelector('input[type="email"]');
    const hasTextarea = !!form.querySelector("textarea");
    // Exclude admin/editor forms by ids we know
    const forbidden = form.querySelector('#prod-name, #blog-title, #gemini-api-key, #admin-hero-title, #prod-id');
    return hasEmail && hasTextarea && !forbidden;
  }

  async function submitForm(form) {
    const emailEl = form.querySelector('input[type="email"]');
    const nameEl = findByLabel(form, "όνομα") || form.querySelector('input[type="text"]');
    const phoneEl = findByLabel(form, "τηλέφων") || form.querySelector('input[type="tel"]');
    const interestEl = findByLabel(form, "ενδια") || form.querySelector("select");
    const msgEl = form.querySelector("textarea");

    const payload = {
      name: pickValue(nameEl) || "—",
      email: pickValue(emailEl),
      phone: pickValue(phoneEl),
      interest: pickValue(interestEl),
      message: pickValue(msgEl),
    };

    if (!payload.email || !payload.message) {
      toast("Συμπλήρωσε email και μήνυμα.");
      return;
    }

    const r = await fetch("/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) {
      toast("Δεν στάλθηκε. Δοκίμασε ξανά σε λίγο.");
      return;
    }

    // success
    try { form.reset(); } catch {}
    toast("Το μήνυμά σας εστάλη! Θα επικοινωνήσουμε σύντομα.");

    // If a modal close function exists, call it.
    try { if (typeof window.closeModal === "function") window.closeModal(); } catch {}
  }

  function wire() {
    const forms = Array.from(document.querySelectorAll("form")).filter(isContactLike);
    if (!forms.length) return;

    forms.forEach(form => {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
        submitForm(form).catch(() => toast("Κάτι πήγε στραβά με την αποστολή."));
      }, true); // capture
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wire);
  } else {
    wire();
  }
})();
