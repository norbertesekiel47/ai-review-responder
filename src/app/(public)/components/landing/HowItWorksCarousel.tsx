'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';

export interface CarouselStep {
  step: string;
  title: string;
  description: string;
  color: string;
}

interface HowItWorksCarouselProps {
  steps: CarouselStep[];
}

export function HowItWorksCarousel({ steps }: HowItWorksCarouselProps) {
  const [currentStep, setCurrentStep] = useState(0);
  const [direction, setDirection] = useState(0);

  const goNext = () => {
    if (currentStep < steps.length - 1) {
      setDirection(1);
      setCurrentStep((s) => s + 1);
    }
  };

  const goPrev = () => {
    if (currentStep > 0) {
      setDirection(-1);
      setCurrentStep((s) => s - 1);
    }
  };

  const goTo = (index: number) => {
    if (index === currentStep) return;
    setDirection(index > currentStep ? 1 : -1);
    setCurrentStep(index);
  };

  // Safe: currentStep is always in [0, steps.length - 1] due to boundary guards
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const step = steps[currentStep]!;

  return (
    <div>
      <div
        className="relative flex items-center justify-center"
        style={{ perspective: '1200px' }}
      >
        {/* Previous Arrow */}
        <button
          onClick={goPrev}
          disabled={currentStep === 0}
          aria-label="Previous step"
          className={`absolute left-4 z-10 w-12 h-12 rounded-full bg-white/60 backdrop-blur-md border border-[#97B3AE]/20 flex items-center justify-center transition-all ${
            currentStep === 0
              ? 'opacity-30 cursor-not-allowed'
              : 'opacity-80 hover:opacity-100 hover:scale-110'
          }`}
        >
          <svg className="w-6 h-6 text-[#97B3AE]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>

        {/* Card Container */}
        <div className="w-96 h-[28rem] relative">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={currentStep}
              initial={{
                rotateY: direction > 0 ? 90 : -90,
                opacity: 0,
                x: direction > 0 ? 100 : -100,
              }}
              animate={{ rotateY: 0, opacity: 1, x: 0 }}
              exit={{
                rotateY: direction > 0 ? -90 : 90,
                opacity: 0,
                x: direction > 0 ? -100 : 100,
              }}
              transition={{ duration: 0.5, ease: 'easeInOut' }}
              className="absolute inset-0"
              style={{ transformStyle: 'preserve-3d' }}
            >
              <div
                className="w-full h-full rounded-3xl p-8 shadow-2xl border border-white/60 flex flex-col justify-between"
                style={{
                  background: `linear-gradient(135deg, ${step.color}40 0%, ${step.color}20 100%)`,
                  backdropFilter: 'blur(10px)',
                }}
              >
                <div>
                  <div className="text-6xl font-bold mb-6 opacity-20 text-[#2a2a2a]">
                    {step.step}
                  </div>
                  <h3 className="text-2xl mb-4 text-[#2a2a2a]">
                    {step.title}
                  </h3>
                  <p className="text-[#6a6a6a] leading-relaxed">
                    {step.description}
                  </p>
                </div>
                <div className="mt-8 h-32 rounded-2xl bg-white/40 flex items-center justify-center border border-white/60">
                  <div className="w-16 h-16 rounded-full bg-gradient-to-br from-white to-white/60 flex items-center justify-center">
                    <div
                      className="w-8 h-8 rounded-full"
                      style={{ backgroundColor: step.color }}
                    />
                  </div>
                </div>
              </div>
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Next Arrow */}
        <button
          onClick={goNext}
          disabled={currentStep === steps.length - 1}
          aria-label="Next step"
          className={`absolute right-4 z-10 w-12 h-12 rounded-full bg-white/60 backdrop-blur-md border border-[#97B3AE]/20 flex items-center justify-center transition-all ${
            currentStep === steps.length - 1
              ? 'opacity-30 cursor-not-allowed'
              : 'opacity-80 hover:opacity-100 hover:scale-110'
          }`}
        >
          <svg className="w-6 h-6 text-[#97B3AE]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      {/* Step Indicators */}
      <div className="flex justify-center mt-8 gap-2">
        {steps.map((_, i) => (
          <button
            key={i}
            onClick={() => goTo(i)}
            aria-label={`Go to step ${i + 1}`}
            className={`h-2 rounded-full transition-all ${
              i === currentStep
                ? 'w-8 bg-[#97B3AE]'
                : 'w-2 bg-[#97B3AE]/30 hover:bg-[#97B3AE]/50'
            }`}
          />
        ))}
      </div>
    </div>
  );
}
