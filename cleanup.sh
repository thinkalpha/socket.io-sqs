for i in $(aws sqs list-queues --output text --no-paginate --query QueueUrls --queue-name-prefix "socketio-test-"); do
    echo $i;
    aws sqs delete-queue --queue-url $i;
done
for i in $(aws sns list-topics  --query 'Topics[].[TopicArn]' --output=text | grep socketio-test-); do
    echo $i;
    aws sns delete-topic --topic-arn $i;
done