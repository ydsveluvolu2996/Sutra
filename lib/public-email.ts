export const SUTRA_EMAIL = {
  contact: "contact@sutracmdb.com",
  support: "support@sutracmdb.com",
  security: "security@sutracmdb.com",
  billing: "billing@sutracmdb.com",
  privacy: "privacy@sutracmdb.com",
} as const;

export const SUTRA_EMAIL_CHANNELS = [
  {
    label: "Product and partnerships",
    address: SUTRA_EMAIL.contact,
    description: "Walkthroughs, onboarding questions, and partnership conversations.",
  },
  {
    label: "Customer support",
    address: SUTRA_EMAIL.support,
    description: "Account access, product help, and operational support.",
  },
  {
    label: "Security",
    address: SUTRA_EMAIL.security,
    description: "Responsible disclosure and security-sensitive reports.",
  },
  {
    label: "Billing",
    address: SUTRA_EMAIL.billing,
    description: "Subscriptions, invoices, and commercial questions.",
  },
  {
    label: "Privacy",
    address: SUTRA_EMAIL.privacy,
    description: "Privacy questions and data-subject requests.",
  },
] as const;
