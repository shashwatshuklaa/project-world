import React from 'react';
import { Zap, Settings, ShieldCheck, Info } from 'lucide-react';

export const HowItWorksSection: React.FC = () => {
  const steps = [
    {
      stepNumber: '01',
      title: 'Browse & Select',
      description:
        'Explore our extensive collection and find the perfect project for your needs.',
      icon: Zap,
      status: 'Active Preview',
      statusColor: 'text-emerald-700 bg-emerald-50 border-emerald-200/80',
    },
    {
      stepNumber: '02',
      title: 'Customize If Needed',
      description:
        'Request specific customizations to tailor the project to your requirements.',
      icon: Settings,
      status: 'Coming Soon',
      statusColor: 'text-amber-700 bg-amber-50 border-amber-200/80',
    },
    {
      stepNumber: '03',
      title: 'Purchase & Download',
      description:
        'Complete your purchase and get instant access to download your projects.',
      icon: ShieldCheck,
      status: 'Coming Soon',
      statusColor: 'text-blue-700 bg-blue-50 border-blue-200/80',
    },
  ];

  return (
    <section
      className="py-16 bg-slate-50/60 border-y border-slate-200/60"
      aria-labelledby="how-it-works-heading"
    >
      <div className="content-container">
        {/* Section Header */}
        <div className="text-center max-w-2xl mx-auto mb-12">
          <span className="inline-block px-3 py-1 mb-3 text-xs font-semibold rounded-full bg-blue-50 text-blue-700 border border-blue-200/60">
            Simple Process
          </span>
          <h2
            id="how-it-works-heading"
            className="text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl mb-4"
          >
            How It Works
          </h2>
          <p className="text-slate-600 text-sm sm:text-base leading-relaxed">
            Get started with Project World in just a few simple steps
          </p>
        </div>

        {/* 3-Step Process Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {steps.map((step) => {
            const Icon = step.icon;

            return (
              <div
                key={step.title}
                className="relative flex flex-col h-full bg-white rounded-2xl border border-slate-200/80 p-8 text-center shadow-xs hover:shadow-md transition-all duration-300"
              >
                {/* Step Number Tag */}
                <span className="absolute top-4 right-4 text-xs font-bold text-slate-300">
                  {step.stepNumber}
                </span>

                {/* Icon Circle */}
                <div className="mx-auto w-16 h-16 rounded-2xl bg-blue-50 border border-blue-100 flex items-center justify-center mb-6 text-blue-600 shadow-2xs">
                  <Icon className="h-8 w-8" />
                </div>

                {/* Title */}
                <h3 className="text-lg font-bold text-slate-900 mb-3">
                  {step.title}
                </h3>

                {/* Description */}
                <p className="text-xs sm:text-sm text-slate-600 leading-relaxed mb-6 flex-grow">
                  {step.description}
                </p>

                {/* Status Indicator */}
                <div className="pt-4 border-t border-slate-100 mt-auto">
                  <span
                    className={`inline-block text-[11px] font-semibold px-2.5 py-0.5 rounded-full border ${step.statusColor}`}
                  >
                    {step.status}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Status Callout Note */}
        <div className="mt-10 max-w-xl mx-auto flex items-center gap-3 p-4 rounded-xl bg-blue-50/70 border border-blue-200/60 text-xs text-blue-800">
          <Info className="h-4 w-4 shrink-0 text-blue-600" />
          <p>
            <span className="font-semibold">Platform Status:</span> We are currently showcasing catalog projects. Direct checkout and customized modification requests will roll out in upcoming phases.
          </p>
        </div>
      </div>
    </section>
  );
};

export default HowItWorksSection;
