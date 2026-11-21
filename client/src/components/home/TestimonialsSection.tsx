import React from 'react';
import { Star, Users, Quote } from 'lucide-react';

interface TestimonialItem {
  name: string;
  role: string;
  quote: string;
  rating: number;
}

export const TestimonialsSection: React.FC = () => {
  const testimonials: TestimonialItem[] = [
    {
      name: 'Satyam Kharwar',
      role: 'Computer Science Student',
      quote:
        'The web development project I purchased saved me countless hours of work. The code was well-documented and easy to understand.',
      rating: 5,
    },
    {
      name: 'Nikhil Kumar',
      role: 'Project Manager',
      quote:
        "I used the management dashboard for my team's project tracking. The customization option allowed me to tailor it perfectly to our needs.",
      rating: 4,
    },
    {
      name: 'Priya Sharma',
      role: 'Engineering Professional',
      quote:
        'The engineering calculation tool was exactly what I needed for my work. The support team was also very helpful with my questions.',
      rating: 5,
    },
  ];

  return (
    <section className="py-16 bg-white" aria-labelledby="testimonials-heading">
      <div className="content-container">
        {/* Section Header */}
        <div className="text-center max-w-2xl mx-auto mb-12">
          <span className="inline-block px-3 py-1 mb-3 text-xs font-semibold rounded-full bg-blue-50 text-blue-700 border border-blue-200/60">
            Customer Feedback
          </span>
          <h2
            id="testimonials-heading"
            className="text-3xl font-extrabold tracking-tight text-slate-900 sm:text-4xl mb-4"
          >
            What Our Customers Say
          </h2>
          <p className="text-slate-600 text-sm sm:text-base leading-relaxed">
            Hear from students and professionals who have used our projects
          </p>
        </div>

        {/* Testimonials Grid */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 sm:gap-8">
          {testimonials.map((testimonial) => (
            <div
              key={testimonial.name}
              className="flex flex-col h-full bg-white rounded-2xl border border-slate-200/80 p-6 sm:p-7 shadow-xs hover:shadow-md transition-all duration-300"
            >
              {/* Star Rating Header */}
              <div className="flex items-center justify-between mb-4">
                <div
                  className="flex items-center gap-1"
                  aria-label={`${testimonial.rating} out of 5 stars`}
                >
                  {Array.from({ length: 5 }).map((_, index) => (
                    <Star
                      key={index}
                      className={`h-4 w-4 ${
                        index < testimonial.rating
                          ? 'fill-amber-400 text-amber-400'
                          : 'fill-slate-100 text-slate-300'
                      }`}
                    />
                  ))}
                </div>
                <Quote className="h-5 w-5 text-slate-300" aria-hidden="true" />
              </div>

              {/* Quote Body */}
              <p className="text-xs sm:text-sm text-slate-600 italic leading-relaxed mb-6 flex-grow">
                &ldquo;{testimonial.quote}&rdquo;
              </p>

              {/* Attribution */}
              <div className="flex items-center gap-3 pt-4 border-t border-slate-100 mt-auto">
                <div className="w-10 h-10 rounded-full bg-blue-50 border border-blue-200/60 flex items-center justify-center text-blue-600 shrink-0">
                  <Users className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-xs sm:text-sm font-bold text-slate-900">
                    {testimonial.name}
                  </h3>
                  <p className="text-[11px] text-slate-500">
                    {testimonial.role}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
};

export default TestimonialsSection;
