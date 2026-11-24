import { redirect } from 'next/navigation';

// LandingLab standalone: a home é a lista de landings.
export default function Home(): never {
  redirect('/landing-pages');
}
