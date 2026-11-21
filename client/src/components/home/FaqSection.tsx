import React, { useState } from 'react';
import { ChevronDown } from 'lucide-react';

interface FaqItem {
  question: string;
  answer: string;
}

export const FaqSection: React.FC = () => {
  // Support toggling individual FAQ items
  const [openIndices, setOpenIndices] = useState<number[]>([0]); // First item open by default

  const toggleFaq = (index: number) => {
    setOpenIndices((prev) =>
      prev.includes(index) ? prev.filter((i) => i !== index) : [...prev, index]
    );
  };

  const faqs: FaqItem[] = [
    {
      question: 'Are the projects ready to use?',
      answer:
        'Yes, all our projects are fully functional and ready to use. Some may require minor setup or configuration based on your specific environment.',
    },
    {
      question: 'Can I request customizations?',
      answer:
        'Absolutely! During checkout, you can provide detailed customization requests in the provided text area for each item in your cart.',
    },
    {
      question: 'How do I download my purchased projects?',
      answer:
        "After successful payment, you'll receive immediate access to download your purchased projects from your account dashboard.",
    },
    {
      question: 'Do you offer refunds?',
      answer:
        "We offer refunds within 7 days of purchase if the project doesn't match the description or has significant technical issues that cannot be resolved.",
    },
  ];

  return (
    <section className="py-16 bg-slate-50/60 border-t border-slate-200/60" id="faq" aria-labelledby="faq-heading">
      <div className="content-container">
        {/* Section Header */}
        <div className="text-center max-w-2xl mx-auto mb-12">
          <span className="inline-block px-3 py-1 mb-3 text-xs font-semibold rounded-full bg-blue-50 text-blue-700 border border-blue-200/60">
            Got Questions?
          </span>
          <h2
            id="faq-heading"
            className="text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl mb-4"
          >
            Frequently Asked Questions
          </h2>
          <p className="text-slate-600 text-sm sm:text-base leading-relaxed">
            Find answers to common questions about our projects and services
          </p>
        </div>

        {/* FAQ Accordion List */}
        <div className="max-w-3xl mx-auto space-y-3.5">
          {faqs.map((faq, index) => {
            const isOpen = openIndices.includes(index);
            const questionId = `faq-question-${index}`;
            const answerId = `faq-answer-${index}`;

            return (
              <div
                key={faq.question}
                className="rounded-2xl border border-slate-200/80 bg-white shadow-xs overflow-hidden transition-all duration-200"
              >
                <button
                  type="button"
                  id={questionId}
                  onClick={() => toggleFaq(index)}
                  aria-expanded={isOpen}
                  aria-controls={answerId}
                  className="w-full flex items-center justify-between p-5 sm:p-6 text-left cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-inset transition-colors hover:bg-slate-50/70"
                >
                  <span className="text-sm sm:text-base font-bold text-slate-900 pr-4">
                    {faq.question}
                  </span>
                  <div
                    className={`h-7 w-7 rounded-full flex items-center justify-center bg-slate-100 text-slate-500 shrink-0 transition-transform duration-200 ${
                      isOpen ? 'rotate-180 bg-blue-50 text-blue-600' : ''
                    }`}
                  >
                    <ChevronDown className="h-4 w-4" aria-hidden="true" />
                  </div>
                </button>

                {isOpen && (
                  <div
                    id={answerId}
                    role="region"
                    aria-labelledby={questionId}
                    className="px-5 pb-5 sm:px-6 sm:pb-6 text-xs sm:text-sm text-slate-600 leading-relaxed border-t border-slate-100 animate-in fade-in duration-150"
                  >
                    <p className="pt-3">{faq.answer}</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};

export default FaqSection;
