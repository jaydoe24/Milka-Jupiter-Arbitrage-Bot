export interface Order {
    id: string;
    price: number;
    quantity: number;
}

export interface OrderBook {
    bids: Order[];
    asks: Order[];
}

export class OrderBookService {
    private orderBook: OrderBook;

    constructor() {
        this.orderBook = { bids: [], asks: [] };
    }

    public updateOrderBook(newOrderBook: OrderBook): void {
        this.orderBook = newOrderBook;
    }

    public getOrderBook(): OrderBook {
        return this.orderBook;
    }

    public addBid(order: Order): void {
        this.orderBook.bids.push(order);
        this.orderBook.bids.sort((a, b) => b.price - a.price);
    }

    public addAsk(order: Order): void {
        this.orderBook.asks.push(order);
        this.orderBook.asks.sort((a, b) => a.price - b.price);
    }
}