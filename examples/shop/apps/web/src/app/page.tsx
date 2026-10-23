import { Button } from '@shop/ui';
import { formatMoney } from '@shop/domain';
import { ProductGrid } from '../components/product-grid';

export default function Home() {
  return (
    <main>
      <ProductGrid />
      <Button>Checkout {formatMoney({ amount: 0, currency: 'USD' })}</Button>
    </main>
  );
}
