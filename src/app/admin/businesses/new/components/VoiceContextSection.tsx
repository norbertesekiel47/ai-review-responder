'use client';

import type { FieldErrors, UseFormRegister } from 'react-hook-form';
import type { FormData } from '../schema';
import { Field, SectionCard, inputClass, textareaClass } from './_shared';

interface VoiceContextSectionProps {
  register: UseFormRegister<FormData>;
  errors: FieldErrors<FormData>;
}

export function VoiceContextSection({ register, errors }: VoiceContextSectionProps) {
  return (
    <SectionCard title="Voice &amp; Context">
      <Field label="Tone" error={errors.tone?.message}>
        <select {...register('tone')} className={inputClass}>
          <option value="warm and casual">Warm and casual</option>
          <option value="professional and friendly">Professional and friendly</option>
          <option value="professional and reassuring">Professional and reassuring</option>
          <option value="professional and gracious">Professional and gracious</option>
          <option value="warm and personal">Warm and personal</option>
          <option value="professional and caring">Professional and caring</option>
        </select>
      </Field>

      <Field
        label="Products / Services"
        error={errors.productsServices?.message}
        hint="Brief description of what this business offers"
      >
        <textarea
          {...register('productsServices')}
          className={textareaClass}
          placeholder="We serve authentic Italian cuisine, wood-fired pizza, and craft cocktails..."
        />
      </Field>

      <Field
        label="Staff Names"
        error={errors.staffNames?.message}
        hint="Names the AI can reference in responses"
      >
        <input
          {...register('staffNames')}
          type="text"
          className={inputClass}
          placeholder="Maria, Carlos, Chef Diego"
        />
      </Field>

      <Field
        label="Highlight Facts"
        error={errors.highlightFacts?.message}
        hint="One per line — things the AI should emphasize (awards, specials, etc.)"
      >
        <textarea
          {...register('highlightFacts')}
          className={textareaClass}
          placeholder={'Best of City Award 2024\nHappy hour Mon–Fri 4–6pm'}
        />
      </Field>

      <Field
        label="Avoid Facts"
        error={errors.avoidFacts?.message}
        hint="One per line — topics the AI must never mention"
      >
        <textarea
          {...register('avoidFacts')}
          className={textareaClass}
          placeholder={'parking situation\nprice comparisons'}
        />
      </Field>

      <Field
        label="Sample Responses"
        error={errors.sampleResponses?.message}
        hint="Paste example responses that match the owner's voice"
      >
        <textarea
          {...register('sampleResponses')}
          className={textareaClass}
          placeholder="Thank you so much for visiting us! We love hearing..."
        />
      </Field>
    </SectionCard>
  );
}
