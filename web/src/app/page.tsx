import { redirect } from "next/navigation";

// The product lives at /shield; the network setup checker moved to /setup.
export default function Home() {
  redirect("/shield");
}
